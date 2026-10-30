const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "20kb" }));

const projectId = process.env.FIREBASE_PROJECT_ID || "tanmayi-store-and-gifts";
if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else {
    credential = admin.credential.applicationDefault();
  }
  admin.initializeApp({ credential, projectId });
}
const db = admin.firestore();
const auth = admin.auth();
const RESET_COLLECTION = "pinResetAuthorizations";
const CODE_TTL_MS = 10 * 60 * 1000;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const makeCode = () => crypto.randomInt(0, 1000000).toString().padStart(6, "0");

function requireFields(body, fields) {
  for (const field of fields) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      const error = new Error(`Missing or invalid ${field}`);
      error.status = 400;
      throw error;
    }
  }
}
async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Admin login required." });
    const decoded = await auth.verifyIdToken(header.slice(7));
    const snap = await db.collection("admins").doc(decoded.uid).get();
    if (!snap.exists || snap.data().role !== "admin" || snap.data().active !== true) {
      return res.status(403).json({ error: "Only an active shop admin can issue reset codes." });
    }
    req.adminUid = decoded.uid;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Admin session is invalid. Please login again." });
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "tanmayi-pin-reset" }));

// Admin-only: create/replace the one pending authorization for this customer.
app.post("/api/admin/issue-reset", requireAdmin, async (req, res) => {
  try {
    requireFields(req.body, ["customerUid"]);
    const customerUid = req.body.customerUid.trim();
    if (customerUid.length > 128) return res.status(400).json({ error: "Invalid customer ID." });
    const customer = await db.collection("customers").doc(customerUid).get();
    if (!customer.exists || !/^\d{10}$/.test(String(customer.data().mobile || ""))) {
      return res.status(404).json({ error: "Customer account was not found." });
    }
    const code = makeCode();
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + CODE_TTL_MS);
    await db.collection(RESET_COLLECTION).doc(customerUid).set({
      customerUid,
      codeHash: sha256(code),
      expiresAt,
      used: false,
      issuedBy: req.adminUid,
      issuedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return res.json({ ok: true, code, expiresInSeconds: 600 });
  } catch (error) {
    console.error("issue-reset:", error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : "Could not issue reset code." });
  }
});

// Customer: code is single-use, expires after 10 minutes, and only changes Auth password.
app.post("/api/customer/reset-pin", async (req, res) => {
  let customerUid = "";
  let claimed = false;
  try {
    requireFields(req.body, ["mobile", "code", "newPin"]);
    const mobile = req.body.mobile.trim();
    const code = req.body.code.trim();
    const newPin = req.body.newPin;
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: "Enter a valid registered 10-digit mobile number." });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Reset code must contain 6 digits." });
    if (!/^\d{6}$/.test(newPin)) return res.status(400).json({ error: "New PIN must contain exactly 6 digits." });

    const matches = await db.collection("customers").where("mobile", "==", mobile).limit(2).get();
    if (matches.size !== 1) return res.status(400).json({ error: "Customer account could not be verified. Contact the shop admin." });
    customerUid = matches.docs[0].id;
    const resetRef = db.collection(RESET_COLLECTION).doc(customerUid);
    const suppliedHash = sha256(code);

    // Atomically claim the code so concurrent requests cannot use it twice.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(resetRef);
      if (!snap.exists) throw new Error("No reset code found. Ask the shop admin for a new code.");
      const data = snap.data();
      if (data.used === true) throw new Error("This reset code has already been used. Ask the admin for a new code.");
      if (!data.expiresAt || data.expiresAt.toMillis() <= Date.now()) throw new Error("Reset code expired. Ask the admin for a fresh code.");
      if (data.codeHash !== suppliedHash) throw new Error("Incorrect reset code.");
      tx.update(resetRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
      claimed = true;
    });

    try {
      const user = await auth.getUser(customerUid);
      const expectedEmail = `${mobile}@tanmayi-loyalty.app`;
      if (user.email !== expectedEmail) throw new Error("Customer login account does not match the registered mobile.");
      await auth.updateUser(customerUid, { password: newPin });
    } catch (error) {
      // If Auth update fails, release the claim only while the original code is still valid.
      if (claimed) {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(resetRef);
          if (snap.exists && snap.data().used === true && snap.data().expiresAt.toMillis() > Date.now()) {
            tx.update(resetRef, { used: false, usedAt: admin.firestore.FieldValue.delete() });
          }
        }).catch(() => {});
      }
      throw error;
    }
    return res.json({ ok: true, message: "PIN reset successful." });
  } catch (error) {
    const known = [
      "No reset code found. Ask the shop admin for a new code.",
      "This reset code has already been used. Ask the admin for a new code.",
      "Reset code expired. Ask the admin for a fresh code.",
      "Incorrect reset code.",
      "Customer login account does not match the registered mobile."
    ];
    const status = known.includes(error.message) ? 400 : (error.status || 500);
    console.error("customer reset:", error.message);
    return res.status(status).json({ error: known.includes(error.message) ? error.message : "PIN reset could not be completed. Please contact the shop admin." });
  }
});


// ---------------- TANMAYI LOYALTY API ----------------
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Login required." });
    req.user = await auth.verifyIdToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please login again." });
  }
}
const customerRef = (uid) => db.collection("customers").doc(uid);
const moneyNumber = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const asMillis = (v) => v && typeof v.toMillis === "function" ? v.toMillis() : 0;
function safeDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}
async function getAdminCustomer(uid) {
  const ref = customerRef(uid), snap = await ref.get();
  if (!snap.exists) return null;
  const d = snap.data();
  const billsSnap = await ref.collection("bills").orderBy("date", "desc").get().catch(async () => ref.collection("bills").get());
  const bills = billsSnap.docs.map(x => ({ id:x.id, amount:moneyNumber(x.data().billTotal), stampsAdded:moneyNumber(x.data().stampsAdded), date:safeDate(x.data().date) }));
  const lifetime = bills.reduce((n,b)=>n+b.amount,0);
  const cycle = moneyNumber(d.cycleBillTotal ?? d.billTotal);
  const redSnap = await ref.collection("redemptions").orderBy("date","desc").get().catch(()=>ref.collection("redemptions").get());
  const redemptions = redSnap.docs.map(x=>({id:x.id,...x.data(),date:safeDate(x.data().date),takenAt:safeDate(x.data().takenAt)}));
  return { id:uid, name:d.name||"", mobile:d.mobile||"", village:d.village||"", stamps:moneyNumber(d.stamps), cycleBillTotal:cycle, lifetimeBillTotal:moneyNumber(d.lifetimeBillTotal ?? lifetime), bills, redemptions };
}
app.post("/api/customer/register", requireUser, async (req,res) => {
  try {
    const {name,mobile,village}=req.body||{};
    if(typeof name!=="string"||!name.trim()||typeof village!=="string"||!village.trim()||!/^\d{10}$/.test(String(mobile||""))) return res.status(400).json({error:"Enter name, village and valid mobile number."});
    if(req.user.email!==`${mobile}@tanmayi-loyalty.app`) return res.status(403).json({error:"Mobile number does not match this login."});
    const ref=customerRef(req.user.uid);
    await db.runTransaction(async tx=>{
      const s=await tx.get(ref);
      if(s.exists) throw new Error("Customer profile already exists.");
      tx.create(ref,{name:name.trim(),mobile:String(mobile),village:village.trim(),stamps:0,billTotal:0,cycleBillTotal:0,lifetimeBillTotal:0,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    res.json({ok:true});
  } catch(e){res.status(400).json({error:e.message||"Registration failed."});}
});
app.get("/api/customer/home", requireUser, async (req,res)=>{
  try {
    const snap=await customerRef(req.user.uid).get();
    if(!snap.exists) return res.status(404).json({error:"Customer profile not found."});
    const d=snap.data(), bills=await customerRef(req.user.uid).collection("bills").orderBy("date","desc").limit(1).get().catch(()=>({docs:[]}));
    const latestBillDoc=bills.docs[0]||null;
    // Show only a bill from the current, unredeemed cycle as the customer's Latest bill.
    // Historical bills remain stored and visible in Bill History.
    const latestBillData=latestBillDoc?latestBillDoc.data():null;
    const latestBillIsCurrent=!!latestBillData && (!d.lastRedeemedAt || asMillis(latestBillData.date)>asMillis(d.lastRedeemedAt));
    const pending=await customerRef(req.user.uid).collection("redemptions").where("status","==","pending").limit(1).get();
    const allRed=await customerRef(req.user.uid).collection("redemptions").where("status","==","taken").get();
    res.json({profile:{name:d.name||"",mobile:d.mobile||"",village:d.village||""},stamps:moneyNumber(d.stamps),latestBill:latestBillIsCurrent?safeDate(latestBillData.date):null,latestBillAmount:latestBillIsCurrent?moneyNumber(latestBillData.billTotal):0,giftsRedeemed:allRed.size,pendingRedemption:pending.empty?null:(()=>{const x=pending.docs[0];const a=x.data();return{id:x.id,type:a.type,approvedPoints:moneyNumber(a.approvedPoints),status:a.status,createdAt:safeDate(a.date)}})()});
  }catch(e){console.error("customer home",e);res.status(500).json({error:"Could not load customer account."});}
});
app.get("/api/customer/history", requireUser, async (req,res)=>{
  try {
    const s=await customerRef(req.user.uid).collection("bills").orderBy("date","desc").limit(100).get().catch(()=>({docs:[]}));
    // Customer-visible history intentionally excludes bill amount and stamp count.
    res.json({history:s.docs.map(x=>({id:x.id,date:safeDate(x.data().date)}))});
  }catch(e){res.status(500).json({error:"Could not load bill history."});}
});
app.post("/api/customer/redeem-taken", requireUser, async (req,res)=>{
  try {
    const redemptionId=String(req.body?.redemptionId||"");
    const choice=String(req.body?.choice||"gift");
    if(!["gift","points"].includes(choice)) return res.status(400).json({error:"Choose gift or points."});
    if(!redemptionId) return res.status(400).json({error:"Redemption reference is required."});
    const cRef=customerRef(req.user.uid), rRef=cRef.collection("redemptions").doc(redemptionId);
    let outcome;
    await db.runTransaction(async tx=>{
      const [cs,rs]=await Promise.all([tx.get(cRef),tx.get(rRef)]);
      if(!cs.exists||!rs.exists) throw new Error("Redemption not found.");
      const r=rs.data();
      if(r.status!=="pending") throw new Error("This redemption has already been completed or is no longer available.");
      if(choice==="points" && moneyNumber(r.approvedPoints)<=0) throw new Error("Points were not approved for this redemption.");
      if(moneyNumber(cs.data().stamps)<10) throw new Error("You are not currently eligible. Please contact the shop.");
      tx.update(cRef,{stamps:0,billTotal:0,cycleBillTotal:0,lastRedeemedAt:admin.firestore.FieldValue.serverTimestamp()});
      tx.update(rRef,{status:"taken",chosenReward:choice,pointsPaid:choice==="points"?moneyNumber(r.approvedPoints):0,takenAt:admin.firestore.FieldValue.serverTimestamp(),takenBy:req.user.uid});
      outcome={type:choice,approvedPoints:choice==="points"?moneyNumber(r.approvedPoints):0};
    });
    res.json({ok:true,message:"Redemption completed.",...outcome});
  }catch(e){res.status(400).json({error:e.message||"Could not complete redemption."});}
});
app.get("/api/admin/customers", requireAdmin, async (_req,res)=>{
  try {
    const s=await db.collection("customers").get();
    const rows=[];
    for(const d of s.docs){if(d.id==="AUTO-ID")continue;const data=d.data();rows.push({id:d.id,name:data.name||"",mobile:data.mobile||"",village:data.village||"",stamps:moneyNumber(data.stamps),createdAt:safeDate(data.createdAt)});}
    res.json({customers:rows});
  }catch(e){res.status(500).json({error:"Could not load customers."});}
});
app.get("/api/admin/customer/:uid", requireAdmin, async (req,res)=>{
  try {const data=await getAdminCustomer(req.params.uid);if(!data)return res.status(404).json({error:"Customer not found."});res.json(data);}
  catch(e){console.error("admin customer",e);res.status(500).json({error:"Could not load customer details."});}
});
app.post("/api/admin/add-bill", requireAdmin, async (req,res)=>{
  try {
    const uid=String(req.body?.customerUid||""), amount=Number(req.body?.amount);
    if(!uid||!Number.isFinite(amount)||amount<=0||amount>10000000) return res.status(400).json({error:"Enter a valid bill amount."});
    const ref=customerRef(uid), billRef=ref.collection("bills").doc(), stampsAdded=amount<=800?1:2;
    const oldBills=await ref.collection("bills").get();
    const legacyLifetime=oldBills.docs.reduce((n,x)=>n+moneyNumber(x.data().billTotal),0);
    await db.runTransaction(async tx=>{
      const s=await tx.get(ref);if(!s.exists)throw new Error("Customer not found.");
      const d=s.data(), oldCycle=moneyNumber(d.cycleBillTotal ?? d.billTotal), oldLife=d.lifetimeBillTotal===undefined?legacyLifetime:moneyNumber(d.lifetimeBillTotal);
      tx.update(ref,{stamps:moneyNumber(d.stamps)+stampsAdded,billTotal:oldCycle+amount,cycleBillTotal:oldCycle+amount,lifetimeBillTotal:oldLife+amount});
      tx.create(billRef,{billTotal:amount,stampsAdded,date:admin.firestore.FieldValue.serverTimestamp(),enteredBy:req.adminUid});
    });
    res.json({ok:true,stampsAdded});
  }catch(e){res.status(400).json({error:e.message||"Could not save bill."});}
});
app.post("/api/admin/create-redemption", requireAdmin, async (req,res)=>{
  try {
    const uid=String(req.body?.customerUid||""), points=Number(req.body?.approvedPoints||0);
    if(!uid||!Number.isInteger(points)||points<0||points>1000000) return res.status(400).json({error:"Approved points must be a whole rupee amount (0 or more)."});
    const ref=customerRef(uid), redRef=ref.collection("redemptions").doc();
    let type="gift";
    await db.runTransaction(async tx=>{
      const s=await tx.get(ref);if(!s.exists)throw new Error("Customer not found.");
      if(moneyNumber(s.data().stamps)<10)throw new Error("Customer needs 10 stamps to be eligible.");
      const existing=await tx.get(ref.collection("redemptions").where("status","==","pending"));
      if(!existing.empty)throw new Error("A redemption is already waiting for customer confirmation.");
      type=points>0?"choice":"gift";
      tx.create(redRef,{type,approvedPoints:points,status:"pending",createdBy:req.adminUid,date:admin.firestore.FieldValue.serverTimestamp(),stampsAtApproval:moneyNumber(s.data().stamps)});
    });
    res.json({ok:true,redemptionId:redRef.id,type,approvedPoints:points});
  }catch(e){res.status(400).json({error:e.message||"Could not create redemption."});}
});
app.get("/api/admin/summary", requireAdmin, async (_req,res)=>{
  try {const s=await db.collection("customers").get();let stamps=0,gifts=0;for(const d of s.docs){stamps+=moneyNumber(d.data().stamps);const r=await d.ref.collection("redemptions").where("status","==","taken").get();gifts+=r.size;}res.json({customerCount:s.size,stampCount:stamps,giftCount:gifts});}
  catch(e){res.status(500).json({error:"Could not load dashboard."});}
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => console.log(`TANMAYI PIN reset API listening on ${port}`));

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

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
const ORDERS_COLLECTION = "customerOrders";
const ORDER_REQUEST_KEYS = "orderRequestKeys";
const CODE_TTL_MS = 10 * 60 * 1000;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const makeCode = () => crypto.randomInt(0, 1000000).toString().padStart(6, "0");

function emailEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
async function sendOrderNotification(order) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return { sent:false, reason:"SMTP_NOT_CONFIGURED" };
  }
  const transporter = nodemailer.createTransport({
    host:SMTP_HOST,
    port:Number(SMTP_PORT),
    secure:String(process.env.SMTP_SECURE || "true").toLowerCase() === "true",
    auth:{ user:SMTP_USER, pass:SMTP_PASS }
  });
  const itemRows = (order.items || []).map(item =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee">${emailEscape(item.productName)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(item.quantity || 0)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${Number(item.offerPrice || 0).toLocaleString("en-IN")}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${Number(item.lineTotal || 0).toLocaleString("en-IN")}</td></tr>`
  ).join("");
  const textItems = (order.items || []).map(x => `${x.productName} | Qty ${x.quantity} | ₹${x.lineTotal}`).join("\n");
  await transporter.sendMail({
    from:process.env.MAIL_FROM || `TANMAYI STORE AND GIFTS <${SMTP_USER}>`,
    to:process.env.ORDER_NOTIFICATION_EMAIL || "srivinayakadthhome@gmail.com",
    subject:`New customer order #${order.orderNumber} – TANMAYI STORE AND GIFTS`,
    text:`New order received\nOrder: #${order.orderNumber}\nCustomer: ${order.customerName}\nMobile: ${order.mobile}\nVillage: ${order.village}\nPayment: CASH ON DELIVERY\nOrder status: CONFIRMED / READY\n\n${textItems}\n\nTotal: ₹${order.total}\nOrder time: ${order.confirmedAtText || "Just now"}`,
    html:`<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222"><div style="background:#171717;color:#d9b45b;padding:22px;border-radius:12px 12px 0 0;text-align:center"><h2 style="margin:0">TANMAYI STORE AND GIFTS</h2><p style="margin:8px 0 0;color:#fff">NEW CUSTOMER ORDER RECEIVED</p></div><div style="border:1px solid #e8dfc9;padding:20px;border-radius:0 0 12px 12px"><h2>Order #${emailEscape(order.orderNumber)}</h2><p><b>Customer:</b> ${emailEscape(order.customerName)}<br><b>Mobile:</b> ${emailEscape(order.mobile)}<br><b>Village:</b> ${emailEscape(order.village)}<br><b>Payment:</b> CASH ON DELIVERY<br><b>Status:</b> CONFIRMED / READY</p><table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:8px">Product</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead><tbody>${itemRows}</tbody></table><h2 style="text-align:right">Total: ₹${Number(order.total || 0).toLocaleString("en-IN")}</h2><p style="color:#666">Order time: ${emailEscape(order.confirmedAtText || "Just now")}</p></div></div>`
  });
  return { sent:true };
}


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
  const bills = billsSnap.docs.map(x => ({ id:x.id, amount:moneyNumber(x.data().billTotal), stampsAdded:moneyNumber(x.data().stampsAdded), source:x.data().source || "admin-bill", productName:x.data().productName || "", date:safeDate(x.data().date) }));
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
    // The authenticated customer can see their own bill date/time and amount.
    res.json({history:s.docs.map(x=>({id:x.id,date:safeDate(x.data().date),amount:moneyNumber(x.data().billTotal)}))});
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
app.get("/api/admin/reward-eligible", requireAdmin, async (_req,res)=>{
  try {
    const snap=await db.collection("customers").get();
    const eligible=[];
    for(const d of snap.docs){
      if(d.id==="AUTO-ID") continue;
      const x=d.data(), stamps=moneyNumber(x.stamps);
      if(stamps>=10){
        const pending=await d.ref.collection("redemptions").where("status","==","pending").limit(1).get();
        eligible.push({id:d.id,name:x.name||"",mobile:x.mobile||"",village:x.village||"",stamps,pendingRedemption:!pending.empty});
      }
    }
    eligible.sort((a,b)=>b.stamps-a.stamps);
    res.json({customers:eligible});
  } catch(e){console.error("reward eligible",e);res.status(500).json({error:"Could not load reward-eligible customers."});}
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


// ---------------- ADMIN PRODUCT PHOTOS & CUSTOMER OFFERS ----------------
const PRODUCTS_COLLECTION = "shopProducts";
const RESERVATIONS_COLLECTION = "offerReservations";
const OFFER_HOLD_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIVE_PRODUCTS = 8;
function decodeImage(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Both product photos are required.");
  const match = dataUrl.match(/^data:image\/(jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("Upload valid JPG, PNG or WEBP photos. Photos are converted to compressed JPG before saving.");
  // Keep each image below 360 KB so both photos fit safely inside Firestore's 1 MiB document limit.
  if (dataUrl.length > 360000) throw new Error("Photo is too large after compression. Please choose a smaller image.");
  return dataUrl;
}
app.get("/api/admin/products", requireAdmin, async (_req, res) => {
  try {
    const [snap, reservationSnap] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).orderBy("createdAt", "desc").get(),
      db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get()
    ]);
    const now = Date.now(), heldByProduct = new Map();
    reservationSnap.docs.forEach(r => {
      const x = r.data();
      if (asMillis(x.expiresAt) > now) heldByProduct.set(x.productId, (heldByProduct.get(x.productId) || 0) + 1);
    });
    res.json({ products: snap.docs.map(d => {
      const x=d.data(), stock=Number.isInteger(Number(x.stock)) ? Number(x.stock) : 0;
      const reservedCount=heldByProduct.get(d.id) || 0;
      return { id:d.id, ...x, stock, reservedCount, availableStock:Math.max(0, stock-reservedCount),
        photoUrls:Array.isArray(x.photoData)?x.photoData:(Array.isArray(x.photoUrls)?x.photoUrls:[]), createdAt:safeDate(x.createdAt) };
    }) });
  } catch (e) { console.error("admin products", e); res.status(500).json({ error:"Could not load products." }); }
});
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  let productRef;
  try {
    const name = String(req.body?.name || "").trim(), originalPrice = Number(req.body?.originalPrice), offerPrice = Number(req.body?.offerPrice), stock = Number(req.body?.stock);
    if (!name || name.length > 80 || !Number.isFinite(originalPrice) || originalPrice <= 0 || !Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice >= originalPrice || !Number.isInteger(stock) || stock < 0) return res.status(400).json({ error:"Enter a product name and valid prices. Offer price must be below original price." });
    const active = await db.collection(PRODUCTS_COLLECTION).where("active", "==", true).get();
    if (active.size >= MAX_ACTIVE_PRODUCTS) return res.status(400).json({ error:"You can keep a maximum of 8 active products. Pause an existing offer first." });
    decodeImage(req.body?.photo1); decodeImage(req.body?.photo2);
    productRef = db.collection(PRODUCTS_COLLECTION).doc();
    const photoData = [decodeImage(req.body.photo1), decodeImage(req.body.photo2)];
    await productRef.set({ name, originalPrice, offerPrice, stock, photoData, active:true, createdAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp(), createdBy:req.adminUid });
    res.json({ ok:true, id:productRef.id });
  } catch (e) { console.error("create product", e); res.status(400).json({ error:e.message || "Could not upload product." }); }
});
app.patch("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const ref = db.collection(PRODUCTS_COLLECTION).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error:"Product not found." });
    const current = snap.data();
    const updates = { updatedAt:admin.firestore.FieldValue.serverTimestamp() };

    if (typeof req.body?.active === "boolean") {
      if (req.body.active) {
        const active = await db.collection(PRODUCTS_COLLECTION).where("active", "==", true).get();
        if (active.size >= MAX_ACTIVE_PRODUCTS && current.active !== true) return res.status(400).json({ error:"Maximum 8 active products reached." });
      }
      updates.active = req.body.active;
    }

    const hasProductEdit = ["name", "originalPrice", "offerPrice"].some(k => req.body?.[k] !== undefined);
    if (hasProductEdit) {
      const name = String(req.body?.name ?? current.name ?? "").trim();
      const originalPrice = Number(req.body?.originalPrice ?? current.originalPrice);
      const offerPrice = Number(req.body?.offerPrice ?? current.offerPrice);
      if (!name || name.length > 80 || !Number.isFinite(originalPrice) || originalPrice <= 0 ||
          !Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice >= originalPrice) {
        return res.status(400).json({ error:"Enter a product name and valid prices. Offer price must be below original price." });
      }
      updates.name = name;
      updates.originalPrice = originalPrice;
      updates.offerPrice = offerPrice;
    }

    if (req.body?.stock !== undefined) {
      const stock = Number(req.body.stock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return res.status(400).json({ error:"Stock must be a whole number from 0 to 100000." });
      const reservations = await db.collection(RESERVATIONS_COLLECTION).where("productId", "==", req.params.id).get();
      const held = reservations.docs.filter(d => d.data().status === "active" && asMillis(d.data().expiresAt) > Date.now()).length;
      if (stock < held) return res.status(400).json({ error:`${held} item(s) are currently confirmed by customers. Stock cannot be lower than this.` });
      updates.stock = stock;
    }

    if (req.body?.photo1 !== undefined || req.body?.photo2 !== undefined) {
      const photos = Array.isArray(current.photoData) ? [...current.photoData] : Array.isArray(current.photoUrls) ? [...current.photoUrls] : [];
      if (req.body?.photo1) photos[0] = decodeImage(req.body.photo1);
      if (req.body?.photo2) photos[1] = decodeImage(req.body.photo2);
      if (!photos[0] || !photos[1]) return res.status(400).json({ error:"Both product photos must be available. Choose both photos if this product has no saved photos." });
      updates.photoData = photos;
    }

    if (Object.keys(updates).length === 1) return res.status(400).json({ error:"No valid product update supplied." });
    await ref.update(updates);
    res.json({ ok:true });
  } catch (e) { console.error("update product", e); res.status(400).json({ error:e.message || "Could not update offer." }); }
});
app.get("/api/customer/offers", requireUser, async (_req, res) => {
  try {
    const snap = await db.collection(PRODUCTS_COLLECTION).where("active", "==", true).get(), now = Date.now();
    const products = [];
    for (const d of snap.docs) {
      const x = d.data(), heldSnap = await db.collection(RESERVATIONS_COLLECTION).where("productId", "==", d.id).get();
      const held = heldSnap.docs.filter(r => r.data().status === "active" && asMillis(r.data().expiresAt) > now).length;
      const stock = Number.isInteger(Number(x.stock)) ? Number(x.stock) : 0;
      products.push({ id:d.id, name:x.name, originalPrice:moneyNumber(x.originalPrice), offerPrice:moneyNumber(x.offerPrice), stock, availableStock:Math.max(0, stock-held), photoUrls:Array.isArray(x.photoData)?x.photoData:(Array.isArray(x.photoUrls)?x.photoUrls:[]) });
    }
    res.json({ products });
  } catch (e) { console.error("customer offers", e); res.status(500).json({ error:"Could not load offers." }); }
});
app.post("/api/customer/reserve-offer", requireUser, async (req, res) => {
  try {
    const productId = String(req.body?.productId || ""); if (!productId) return res.status(400).json({ error:"Select a product." });
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(productId), reservationRef = db.collection(RESERVATIONS_COLLECTION).doc();
    let result;
    await db.runTransaction(async tx => {
      const product = await tx.get(productRef); if (!product.exists || product.data().active !== true) throw new Error("This offer is no longer available.");
      const existing = await tx.get(db.collection(RESERVATIONS_COLLECTION).where("productId", "==", productId));
      const now = Date.now(), stock = Number.isInteger(Number(product.data().stock)) ? Number(product.data().stock) : 0;
      const held = existing.docs.filter(d => d.data().status === "active" && asMillis(d.data().expiresAt) > now).length;
      if (held >= stock) throw new Error("Sorry, this product is out of stock or all pieces are currently selected.");
      const expiresAt = now + OFFER_HOLD_MS;
      tx.create(reservationRef, { customerUid:req.user.uid, productId, productName:product.data().name, offerPrice:moneyNumber(product.data().offerPrice), status:"active", createdAt:admin.firestore.FieldValue.serverTimestamp(), expiresAt:admin.firestore.Timestamp.fromMillis(expiresAt) });
      result = { id:reservationRef.id, expiresAt };
    });
    res.json({ ok:true, reservation:result });
  } catch (e) { res.status(400).json({ error:e.message || "Could not select this offer." }); }
});

// Customer confirms the staged cart. A single order is created with an automatic
// CONFIRMED + READY status and a one-hour collection window. Packing is done in-store
// when the customer arrives; the website does not mark cash paid or award stamps here.
app.post("/api/customer/confirm-offers", requireUser, async (req, res) => {
  let createdOrder = null;
  let isDuplicateRequest = false;
  try {
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds.map(x => String(x || "")).filter(Boolean) : [];
    const clientRequestId = String(req.body?.clientRequestId || "");
    if (!productIds.length) return res.status(400).json({ error:"Add at least one product before confirming." });
    if (productIds.length > 30) return res.status(400).json({ error:"You can confirm up to 30 items at a time." });
    if (!/^[A-Za-z0-9_-]{10,120}$/.test(clientRequestId)) return res.status(400).json({ error:"Please retry confirming your order." });

    const quantities = new Map();
    for (const id of productIds) quantities.set(id, (quantities.get(id) || 0) + 1);
    const productRefs = new Map([...quantities.keys()].map(id => [id, db.collection(PRODUCTS_COLLECTION).doc(id)]));
    const reservationRefs = productIds.map(() => db.collection(RESERVATIONS_COLLECTION).doc());
    const orderRef = db.collection(ORDERS_COLLECTION).doc();
    const requestKey = sha256(`${req.user.uid}:${clientRequestId}`);
    const requestRef = db.collection(ORDER_REQUEST_KEYS).doc(requestKey);
    const counterRef = db.collection("systemCounters").doc("customerOrderNumber");

    await db.runTransaction(async tx => {
      const priorRequest = await tx.get(requestRef);
      if (priorRequest.exists) {
        const priorOrder = await tx.get(db.collection(ORDERS_COLLECTION).doc(priorRequest.data().orderId));
        if (!priorOrder.exists) throw new Error("Your previous order request could not be found. Please contact the shop.");
        createdOrder = { id:priorOrder.id, ...priorOrder.data() };
        isDuplicateRequest = true;
        return;
      }

      const counterSnap = await tx.get(counterRef);
      const customerSnap = await tx.get(customerRef(req.user.uid));
      if (!customerSnap.exists) throw new Error("Customer profile not found. Please login again.");
      const productSnaps = new Map();
      for (const [id, ref] of productRefs) productSnaps.set(id, await tx.get(ref));
      const existingByProduct = new Map();
      for (const id of quantities.keys()) {
        existingByProduct.set(id, await tx.get(db.collection(RESERVATIONS_COLLECTION).where("productId", "==", id)));
      }

      const now = Date.now();
      for (const [id, quantity] of quantities) {
        const productSnap = productSnaps.get(id);
        if (!productSnap?.exists || productSnap.data().active !== true) throw new Error("One of your selected offers is no longer available. Please refresh the offers.");
        const product = productSnap.data();
        const stock = Number.isInteger(Number(product.stock)) ? Number(product.stock) : 0;
        const held = existingByProduct.get(id).docs.filter(d => d.data().status === "active" && asMillis(d.data().expiresAt) > now).length;
        if (held + quantity > stock) throw new Error(`${product.name || "A selected product"} has only ${Math.max(0, stock-held)} piece(s) available now. Please update your selection.`);
      }

      const expiresAt = now + OFFER_HOLD_MS;
      const customer = customerSnap.data();
      const items = [...quantities.entries()].map(([id, quantity]) => {
        const product = productSnaps.get(id).data();
        const offerPrice = moneyNumber(product.offerPrice);
        return { productId:id, productName:product.name || "Product", quantity, offerPrice, lineTotal:offerPrice * quantity };
      });
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const orderNumber = Number(counterSnap.exists ? counterSnap.data().lastOrderNumber || 10000 : 10000) + 1;
      const confirmedAt = admin.firestore.FieldValue.serverTimestamp();
      const orderData = {
        orderNumber, customerUid:req.user.uid,
        customerName:String(customer.name || "Customer"), mobile:String(customer.mobile || ""), village:String(customer.village || ""),
        items, total, paymentMethod:"CASH ON DELIVERY",
        orderStatus:"ready", collectionStatus:"pending", paymentStatus:"pending", stampsStatus:"pending",
        createdAt:confirmedAt, confirmedAt, readyAt:confirmedAt,
        expiresAt:admin.firestore.Timestamp.fromMillis(expiresAt),
        emailStatus:"pending", createdByCustomer:true
      };
      tx.create(orderRef, orderData);
      tx.set(counterRef, { lastOrderNumber:orderNumber, updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      tx.create(requestRef, { orderId:orderRef.id, customerUid:req.user.uid, createdAt:admin.firestore.FieldValue.serverTimestamp() });
      productIds.forEach((id, index) => {
        const product = productSnaps.get(id).data();
        tx.create(reservationRefs[index], {
          customerUid:req.user.uid, productId:id, productName:product.name || "Product",
          offerPrice:moneyNumber(product.offerPrice), orderId:orderRef.id, orderNumber,
          status:"active", createdAt:confirmedAt,
          expiresAt:admin.firestore.Timestamp.fromMillis(expiresAt)
        });
      });
      createdOrder = { id:orderRef.id, ...orderData, confirmedAtText:new Date(now).toLocaleString("en-IN", { timeZone:"Asia/Kolkata" }) };
    });

    let emailSent = createdOrder.emailStatus === "sent";
    if (!isDuplicateRequest && !emailSent) {
      try {
        const mailResult = await sendOrderNotification(createdOrder);
        emailSent = mailResult.sent;
        await orderRef.update({ emailStatus:emailSent ? "sent" : "not_configured", emailUpdatedAt:admin.firestore.FieldValue.serverTimestamp() });
        createdOrder.emailStatus = emailSent ? "sent" : "not_configured";
      } catch (mailError) {
        console.error("order notification email failed:", mailError);
        await orderRef.update({ emailStatus:"failed", emailError:String(mailError.message || "Email failed").slice(0,250), emailUpdatedAt:admin.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
        createdOrder.emailStatus = "failed";
      }
    }
    res.json({ ok:true, order:{ id:createdOrder.id, orderNumber:createdOrder.orderNumber, total:createdOrder.total, expiresAt:asMillis(createdOrder.expiresAt), orderStatus:createdOrder.orderStatus }, duplicateRequest:isDuplicateRequest });
  } catch (e) { console.error("confirm offers", e); res.status(400).json({ error:e.message || "Could not confirm your order." }); }
});

// Customer order history, including the completed order and stamp confirmation.
app.get("/api/customer/my-orders", requireUser, async (req, res) => {
  try {
    const snap = await db.collection(ORDERS_COLLECTION).where("customerUid", "==", req.user.uid).limit(50).get();
    const orders = snap.docs.map(d => {
      const x=d.data();
      return { id:d.id, orderNumber:x.orderNumber, items:x.items || [], total:moneyNumber(x.total), paymentMethod:x.paymentMethod || "CASH ON DELIVERY",
        orderStatus:(x.orderStatus === "ready" && asMillis(x.expiresAt) <= Date.now()) ? "expired" : (x.orderStatus || "ready"), collectionStatus:x.collectionStatus || "pending", paymentStatus:x.paymentStatus || "pending",
        stampsStatus:x.stampsStatus || "pending", stampsAdded:moneyNumber(x.stampsAdded), confirmedAt:safeDate(x.confirmedAt || x.createdAt),
        readyAt:safeDate(x.readyAt), completedAt:safeDate(x.completedAt), expiresAt:asMillis(x.expiresAt) };
    }).sort((a,b)=>new Date(b.confirmedAt || 0)-new Date(a.confirmedAt || 0));
    res.json({ orders });
  } catch (e) { console.error("customer orders", e); res.status(500).json({ error:"Could not load your orders." }); }
});

// Customer can cancel an order while it is still waiting for collection/payment.
app.post("/api/customer/cancel-order", requireUser, async (req, res) => {
  try {
    const orderId=String(req.body?.orderId || "");
    if (!orderId) return res.status(400).json({ error:"Order not found." });
    const orderRef=db.collection(ORDERS_COLLECTION).doc(orderId);
    await db.runTransaction(async tx => {
      const orderSnap=await tx.get(orderRef);
      if (!orderSnap.exists || orderSnap.data().customerUid !== req.user.uid) throw new Error("You cannot cancel this order.");
      const order=orderSnap.data();
      if (order.orderStatus !== "ready" || order.collectionStatus !== "pending" || order.paymentStatus !== "pending") throw new Error("This order can no longer be cancelled online. Please contact the shop.");
      const reservations=await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId","==",orderId));
      reservations.docs.filter(d=>d.data().status === "active").forEach(d=>tx.update(d.ref,{status:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp()}));
      tx.update(orderRef,{orderStatus:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    res.json({ok:true});
  } catch(e) { res.status(400).json({error:e.message || "Could not cancel this order."}); }
});

// Admin order queue. Orders are automatically CONFIRMED and READY on customer submission.
app.get("/api/admin/offer-orders", requireAdmin, async (_req, res) => {
  try {
    const snap=await db.collection(ORDERS_COLLECTION).get();
    const now=Date.now();
    const orders=snap.docs.map(d=>({id:d.id,...d.data(),confirmedAt:safeDate(d.data().confirmedAt || d.data().createdAt),expiresAt:asMillis(d.data().expiresAt)}))
      .filter(x=>(x.orderStatus === "ready" && x.expiresAt > now) || x.orderStatus === "collected")
      .sort((a,b)=>new Date(a.confirmedAt || 0)-new Date(b.confirmedAt || 0));
    res.json({orders});
  } catch(e) { console.error("admin offer orders",e); res.status(500).json({error:"Could not load customer orders."}); }
});

app.post("/api/admin/orders/:id/collect", requireAdmin, async (req,res)=>{
  try {
    const ref=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists) throw new Error("Order not found.");
      const x=snap.data();
      if(x.orderStatus !== "ready" || asMillis(x.expiresAt) <= Date.now()) throw new Error("This order is expired or no longer awaiting collection.");
      if(x.collectionStatus === "collected") return;
      tx.update(ref,{collectionStatus:"collected",orderStatus:"collected",collectedAt:admin.firestore.FieldValue.serverTimestamp(),collectedBy:req.adminUid});
    });
    res.json({ok:true,message:"Order collection marked. Next, confirm cash payment."});
  } catch(e) { res.status(400).json({error:e.message || "Could not update collection status."}); }
});

app.post("/api/admin/orders/:id/payment", requireAdmin, async (req,res)=>{
  try {
    const ref=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists) throw new Error("Order not found.");
      const x=snap.data();
      if(x.collectionStatus !== "collected") throw new Error("Mark the order collected before receiving payment.");
      if(x.paymentStatus === "received") return;
      tx.update(ref,{paymentStatus:"received",paymentReceivedAt:admin.firestore.FieldValue.serverTimestamp(),paymentReceivedBy:req.adminUid});
    });
    res.json({ok:true,message:"Cash payment received. Final approval will add the billing stamps."});
  } catch(e) { res.status(400).json({error:e.message || "Could not update payment status."}); }
});

app.post("/api/admin/orders/:id/complete", requireAdmin, async (req,res)=>{
  try {
    const orderRef=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    let result={};
    await db.runTransaction(async tx=>{
      const orderSnap=await tx.get(orderRef);
      if(!orderSnap.exists) throw new Error("Order not found.");
      const order=orderSnap.data();
      if(order.orderStatus === "completed") throw new Error("This order is already completed. Stamps cannot be added twice.");
      if(order.collectionStatus !== "collected" || order.paymentStatus !== "received") throw new Error("Complete collection and cash payment first.");
      const cRef=customerRef(order.customerUid), customerSnap=await tx.get(cRef);
      if(!customerSnap.exists) throw new Error("Customer account not found.");
      const reservationSnap=await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId","==",req.params.id));
      const activeReservations=reservationSnap.docs.filter(d=>d.data().status === "active");
      if(!activeReservations.length) throw new Error("No active order items found. Please contact support.");
      const qtyByProduct=new Map();
      for(const d of activeReservations){const pid=d.data().productId;qtyByProduct.set(pid,(qtyByProduct.get(pid)||0)+1);}
      const productSnaps=new Map();
      for(const pid of qtyByProduct.keys()) productSnaps.set(pid,await tx.get(db.collection(PRODUCTS_COLLECTION).doc(pid)));
      for(const [pid,qty] of qtyByProduct){const ps=productSnaps.get(pid);if(!ps?.exists)throw new Error("An order product no longer exists.");const stock=Number(ps.data().stock||0);if(stock<qty)throw new Error("Physical stock is lower than this order quantity. Please correct stock before completing.");}
      const amount=moneyNumber(order.total);
      if(!(amount>0)) throw new Error("Order total is invalid.");
      const stampsAdded=amount<=800?1:2;
      const c=customerSnap.data(),cycle=moneyNumber(c.cycleBillTotal ?? c.billTotal),life=moneyNumber(c.lifetimeBillTotal ?? cycle);
      const billRef=cRef.collection("bills").doc();
      for(const [pid,qty] of qtyByProduct){const ps=productSnaps.get(pid);tx.update(ps.ref,{stock:Number(ps.data().stock||0)-qty,updatedAt:admin.firestore.FieldValue.serverTimestamp(),lastCollectedAt:admin.firestore.FieldValue.serverTimestamp()});}
      tx.update(cRef,{stamps:moneyNumber(c.stamps)+stampsAdded,billTotal:cycle+amount,cycleBillTotal:cycle+amount,lifetimeBillTotal:life+amount});
      tx.create(billRef,{billTotal:amount,stampsAdded,source:"shop-order",productName:(order.items||[]).map(x=>x.productName).join(", "),orderNumber:order.orderNumber,items:order.items||[],date:admin.firestore.FieldValue.serverTimestamp(),enteredBy:req.adminUid});
      activeReservations.forEach(d=>tx.update(d.ref,{status:"collected",collectedAt:admin.firestore.FieldValue.serverTimestamp(),collectedBy:req.adminUid}));
      tx.update(orderRef,{orderStatus:"completed",stampsStatus:"added",stampsAdded,completedAt:admin.firestore.FieldValue.serverTimestamp(),completedBy:req.adminUid});
      result={orderNumber:order.orderNumber,amount,stampsAdded};
    });
    res.json({ok:true,...result,message:`Order #${result.orderNumber} completed. Cash received, stock updated, bill ₹${result.amount} added and ${result.stampsAdded} stamp(s) awarded.`});
  } catch(e) { console.error("complete customer order",e); res.status(400).json({error:e.message || "Could not complete this order."}); }
});

app.post("/api/admin/orders/:id/resend-email", requireAdmin, async (req,res)=>{
  try {
    const ref=db.collection(ORDERS_COLLECTION).doc(req.params.id),snap=await ref.get();
    if(!snap.exists) return res.status(404).json({error:"Order not found."});
    const x=snap.data();
    if(x.emailStatus === "sent") return res.json({ok:true,message:"Order email was already sent."});
    const sent=await sendOrderNotification({...x,id:snap.id,confirmedAtText:safeDate(x.confirmedAt)});
    await ref.update({emailStatus:sent.sent?"sent":"not_configured",emailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
    if(!sent.sent) return res.status(400).json({error:"Gmail SMTP is not configured in Render environment variables."});
    res.json({ok:true,message:"Order notification email sent."});
  } catch(e) { console.error("resend order email",e); res.status(500).json({error:"Could not send order notification email."}); }
});

app.post("/api/customer/cancel-offer", requireUser, async (req, res) => {
  try {
    const reservationId = String(req.body?.reservationId || "");
    if (!reservationId) return res.status(400).json({ error:"Selected offer not found." });
    const ref = db.collection(RESERVATIONS_COLLECTION).doc(reservationId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().customerUid !== req.user.uid) throw new Error("You cannot cancel this selection.");
      if (snap.data().status !== "active") throw new Error("This selection is no longer active.");
      tx.update(ref, { status:"cancelled", cancelledAt:admin.firestore.FieldValue.serverTimestamp() });
    });
    res.json({ ok:true });
  } catch (e) { res.status(400).json({ error:e.message || "Could not cancel selected offer." }); }
});

// Admin view: confirmed reservations waiting for the customer to collect in-store.
app.get("/api/admin/offer-orders", requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get();
    const now = Date.now();
    const live = snap.docs.filter(d => asMillis(d.data().expiresAt) > now);
    const groups = new Map();
    for (const d of live) {
      const x = d.data();
      const key = `${x.customerUid}__${x.productId}`;
      if (!groups.has(key)) groups.set(key, {
        customerUid:x.customerUid, productId:x.productId, productName:x.productName || "Product",
        offerPrice:moneyNumber(x.offerPrice), quantity:0, reservationIds:[], expiresAt:0
      });
      const g = groups.get(key);
      g.quantity += 1;
      g.reservationIds.push(d.id);
      g.expiresAt = Math.max(g.expiresAt, asMillis(x.expiresAt));
    }
    const orders = await Promise.all([...groups.values()].map(async g => {
      const [customerSnap, productSnap] = await Promise.all([
        customerRef(g.customerUid).get(),
        db.collection(PRODUCTS_COLLECTION).doc(g.productId).get()
      ]);
      const c = customerSnap.exists ? customerSnap.data() : {};
      const p = productSnap.exists ? productSnap.data() : {};
      return {
        ...g, customerName:c.name || "Customer", mobile:c.mobile || "",
        productName:p.name || g.productName, offerPrice:moneyNumber(p.offerPrice ?? g.offerPrice),
        expiresAt:g.expiresAt, total:moneyNumber(p.offerPrice ?? g.offerPrice) * g.quantity
      };
    }));
    orders.sort((a,b) => a.expiresAt - b.expiresAt);
    res.json({ orders });
  } catch (e) {
    console.error("admin offer orders", e);
    res.status(500).json({ error:"Could not load confirmed customer offers." });
  }
});

// Admin approves only after the customer has physically collected the products.
// Each active reservation represents one piece; approval decrements physical stock.
app.post("/api/admin/offer-orders/approve", requireAdmin, async (req, res) => {
  try {
    const customerUid = String(req.body?.customerUid || "");
    const productId = String(req.body?.productId || "");
    if (!customerUid || !productId) return res.status(400).json({ error:"Customer and product details are required." });
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(productId);
    const cRef = customerRef(customerUid);
    const billRef = cRef.collection("bills").doc();
    let approvedQuantity = 0, approvedAmount = 0, stampsAdded = 0;
    await db.runTransaction(async tx => {
      const productSnap = await tx.get(productRef);
      const customerSnap = await tx.get(cRef);
      if (!productSnap.exists) throw new Error("Product not found.");
      if (!customerSnap.exists) throw new Error("Customer account not found.");
      const reservationQuery = db.collection(RESERVATIONS_COLLECTION).where("productId", "==", productId);
      const reservationSnap = await tx.get(reservationQuery);
      const now = Date.now();
      const eligible = reservationSnap.docs.filter(d => {
        const x=d.data();
        return x.customerUid === customerUid && x.status === "active" && asMillis(x.expiresAt) > now;
      });
      if (!eligible.length) throw new Error("No active confirmed items remain. The offer may have expired or been cancelled.");
      const stock = Number.isInteger(Number(productSnap.data().stock)) ? Number(productSnap.data().stock) : 0;
      if (stock < eligible.length) throw new Error("Physical stock is lower than the confirmed quantity. Check stock before approval.");

      // Keep the price agreed when the customer confirmed the offer.
      approvedQuantity = eligible.length;
      approvedAmount = eligible.reduce((sum,d)=>sum+moneyNumber(d.data().offerPrice),0);
      if (!(approvedAmount > 0)) throw new Error("Could not calculate the confirmed offer amount.");
      stampsAdded = approvedAmount <= 800 ? 1 : 2;

      const c=customerSnap.data();
      const oldCycle=moneyNumber(c.cycleBillTotal ?? c.billTotal);
      const oldLife=moneyNumber(c.lifetimeBillTotal ?? oldCycle);
      tx.update(productRef, {
        stock:stock-approvedQuantity,
        updatedAt:admin.firestore.FieldValue.serverTimestamp(),
        lastCollectedAt:admin.firestore.FieldValue.serverTimestamp()
      });
      tx.update(cRef, {
        stamps:moneyNumber(c.stamps)+stampsAdded,
        billTotal:oldCycle+approvedAmount,
        cycleBillTotal:oldCycle+approvedAmount,
        lifetimeBillTotal:oldLife+approvedAmount
      });
      tx.create(billRef, {
        billTotal:approvedAmount, stampsAdded, source:"shop-offer",
        productName:productSnap.data().name || "Shop offer",
        productId, quantity:approvedQuantity,
        date:admin.firestore.FieldValue.serverTimestamp(),
        enteredBy:req.adminUid
      });
      eligible.forEach(d => tx.update(d.ref, {
        status:"collected",
        collectedAt:admin.firestore.FieldValue.serverTimestamp(),
        collectedBy:req.adminUid
      }));
    });
    res.json({
      ok:true, approvedQuantity, approvedAmount, stampsAdded,
      message:`Collection approved. ${approvedQuantity} piece(s) deducted from stock. Bill ₹${approvedAmount} added and ${stampsAdded} stamp(s) awarded.`
    });
  } catch (e) {
    console.error("approve offer collection", e);
    res.status(400).json({ error:e.message || "Could not approve product collection." });
  }
});
app.get("/api/customer/my-offers", requireUser, async (req, res) => {
  try {
    const snap = await db.collection(RESERVATIONS_COLLECTION).where("customerUid", "==", req.user.uid).limit(50).get(), now = Date.now();
    const reservations = snap.docs.map(d => { const x=d.data(), expiresAt=asMillis(x.expiresAt); return { id:d.id, productName:x.productName||"Product", offerPrice:moneyNumber(x.offerPrice), expiresAt, status:x.status || (expiresAt > now ? "active" : "expired") }; }).filter(x => x.expiresAt > now && x.status === "active").sort((a,b)=>b.expiresAt-a.expiresAt).slice(0,30);
    res.json({ reservations });
  } catch (e) { console.error("customer offers history", e); res.status(500).json({ error:"Could not load your selected offers." }); }
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => console.log(`TANMAYI PIN reset API listening on ${port}`));

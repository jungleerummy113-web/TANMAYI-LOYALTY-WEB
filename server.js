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
async function sendRefundRequestNotification(refund, order, paymentScreenshotData) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ORDER_NOTIFICATION_EMAIL, MAIL_FROM } = process.env;
  const missing = [];
  if (!SMTP_HOST) missing.push('SMTP_HOST');
  if (!SMTP_PORT) missing.push('SMTP_PORT');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  if (missing.length) throw new Error(`Missing SMTP environment variables: ${missing.join(', ')}`);
  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('SMTP_PORT must be a valid port number.');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port,
    secure: String(SMTP_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  const itemLines = (order.items || []).map(item => `${item.productName} | Qty ${item.quantity} | ₹${item.lineTotal}`).join('\n');
  const text = [
    'NEW CUSTOMER REFUND REQUEST – TANMAYI STORE AND GIFTS',
    `Order: #${order.orderNumber}`, `Customer: ${refund.customerName || order.customerName || 'Customer'}`,
    `Mobile: ${refund.mobile || order.mobile || ''}`, `Village: ${order.village || ''}`,
    `Order amount: ₹${Number(order.total || 0).toLocaleString('en-IN')}`,
    `Original payment method: ONLINE PAYMENT`, `Original payment UTR: ${order.paymentUtr || ''}`,
    `Bank account holder name: ${refund.holderName || ''}`, `Customer refund UPI ID / number: ${refund.upiId || ''}`,
    `Refund request time: ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`,
    '', 'ORDER PRODUCTS:', itemLines || 'Product details unavailable.',
    '', 'Please review the customer details and process the refund manually.'
  ].join('\n');
  const attachments = [];
  if (typeof paymentScreenshotData === 'string') {
    const m = paymentScreenshotData.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (m) attachments.push({ filename:`order-${order.orderNumber}-payment-proof.${m[1].toLowerCase()==='jpeg'?'jpg':m[1].toLowerCase()}`, content:Buffer.from(m[2],'base64'), contentType:`image/${m[1].toLowerCase()==='jpg'?'jpeg':m[1].toLowerCase()}` });
  }
  try {
    await transporter.verify();
    const info = await transporter.sendMail({
      from: MAIL_FROM || `TANMAYI STORE AND GIFTS <${SMTP_USER}>`,
      to: ORDER_NOTIFICATION_EMAIL || SMTP_USER,
      subject: `REFUND REQUEST – Order #${order.orderNumber} – TANMAYI STORE AND GIFTS`,
      text,
      html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222"><h2 style="background:#171717;color:#d9b45b;padding:20px">TANMAYI STORE AND GIFTS</h2><h3>NEW CUSTOMER REFUND REQUEST</h3><p><b>Order:</b> #${emailEscape(order.orderNumber)}<br><b>Customer:</b> ${emailEscape(refund.customerName || order.customerName || 'Customer')}<br><b>Mobile:</b> ${emailEscape(refund.mobile || order.mobile || '')}<br><b>Village:</b> ${emailEscape(order.village || '')}<br><b>Order amount:</b> ₹${Number(order.total || 0).toLocaleString('en-IN')}<br><b>Original payment UTR:</b> ${emailEscape(order.paymentUtr || '')}<br><b>Bank holder name:</b> ${emailEscape(refund.holderName || '')}<br><b>Customer UPI ID / number:</b> ${emailEscape(refund.upiId || '')}</p><h4>Products</h4><pre>${emailEscape(itemLines || 'Product details unavailable.')}</pre><p>Please review the details and process the refund manually.</p>${attachments.length?'<p>Original payment screenshot is attached.</p>':''}</div>`,
      attachments
    });
    console.info('REFUND_REQUEST_EMAIL_SENT',{orderNumber:order.orderNumber,messageId:info.messageId});
    return {sent:true,messageId:info.messageId};
  } catch(error) {
    console.error('REFUND_REQUEST_EMAIL_FAILED',{orderNumber:order.orderNumber,code:error.code||'UNKNOWN',message:String(error.message||'Email send failed').slice(0,300)});
    throw error;
  } finally { transporter.close(); }
}

async function sendOrderNotification(order) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ORDER_NOTIFICATION_EMAIL, MAIL_FROM } = process.env;
  const missing = [];
  if (!SMTP_HOST) missing.push('SMTP_HOST');
  if (!SMTP_PORT) missing.push('SMTP_PORT');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  if (missing.length) throw new Error(`Missing SMTP environment variables: ${missing.join(', ')}`);

  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('SMTP_PORT must be a valid port number.');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: String(SMTP_SECURE || (port === 465 ? 'true' : 'false')).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });

  const itemRows = (order.items || []).map(item =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee">${emailEscape(item.productName)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(item.quantity || 0)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${Number(item.offerPrice || 0).toLocaleString('en-IN')}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${Number(item.lineTotal || 0).toLocaleString('en-IN')}</td></tr>`
  ).join('');
  const textItems = (order.items || []).map(item => `${item.productName} | Qty ${item.quantity} | ₹${item.lineTotal}`).join('\n');
  const message = {
    from: MAIL_FROM || `TANMAYI STORE AND GIFTS <${SMTP_USER}>`,
    to: ORDER_NOTIFICATION_EMAIL || SMTP_USER,
    subject: `New customer order #${order.orderNumber} – TANMAYI STORE AND GIFTS`,
    text: `New order received\\nOrder: #${order.orderNumber}\\nCustomer: ${order.customerName}\\nMobile: ${order.mobile}\\nVillage: ${order.village}\\nFulfilment: ${order.fulfilmentMode === "HOME_DELIVERY" ? "HOME DELIVERY" : "VISIT SHOP & COLLECT"}\\nDelivery address: ${order.deliveryAddress ? [order.deliveryAddress.name,order.deliveryAddress.mobile,order.deliveryAddress.address,order.deliveryAddress.area,order.deliveryAddress.landmark,"PIN "+order.deliveryAddress.pincode].join(", ") : "Shop collection"}\\nDelivery charge: ₹${order.deliveryCharge || 0}\\nPayment: ${order.paymentMethod === 'ONLINE_PAYMENT' ? 'ONLINE PAYMENT – UTR ' + (order.paymentUtr || 'submitted') : 'CASH ON DELIVERY'}\\nPayment status: ${order.paymentMethod === 'ONLINE_PAYMENT' ? 'SUBMITTED – ADMIN VERIFICATION REQUIRED' : 'PENDING AT SHOP'}\\nOrder status: CONFIRMED / READY\\n\\n${textItems}\\n\\nTotal: ₹${order.total}\\nOrder time: ${order.confirmedAtText || 'Just now'}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222"><div style="background:#171717;color:#d9b45b;padding:22px;border-radius:12px 12px 0 0;text-align:center"><h2 style="margin:0">TANMAYI STORE AND GIFTS</h2><p style="margin:8px 0 0;color:#fff">NEW CUSTOMER ORDER RECEIVED</p></div><div style="border:1px solid #e8dfc9;padding:20px;border-radius:0 0 12px 12px"><h2>Order #${emailEscape(order.orderNumber)}</h2><p><b>Customer:</b> ${emailEscape(order.customerName)}<br><b>Mobile:</b> ${emailEscape(order.mobile)}<br><b>Village:</b> ${emailEscape(order.village)}<br><b>Fulfilment:</b> ${order.fulfilmentMode === "HOME_DELIVERY" ? "HOME DELIVERY" : "VISIT SHOP & COLLECT"}<br>${order.deliveryAddress ? "<b>Delivery address:</b> " + emailEscape([order.deliveryAddress.name,order.deliveryAddress.mobile,order.deliveryAddress.address,order.deliveryAddress.area,order.deliveryAddress.landmark,"PIN "+order.deliveryAddress.pincode].join(", ")) + "<br>" : ""}<b>Delivery charge:</b> ₹${Number(order.deliveryCharge||0)}<br><b>Payment:</b> ${order.paymentMethod === 'ONLINE_PAYMENT' ? 'ONLINE PAYMENT' : 'CASH ON DELIVERY'}<br><b>Payment status:</b> ${order.paymentMethod === 'ONLINE_PAYMENT' ? 'SUBMITTED – ADMIN VERIFICATION REQUIRED' : 'PENDING AT SHOP'}<br>${order.paymentMethod === 'ONLINE_PAYMENT' ? '<b>UTR:</b> ' + emailEscape(order.paymentUtr || '') + '<br>' : ''}<b>Status:</b> CONFIRMED / READY</p><table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:8px">Product</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead><tbody>${itemRows}</tbody></table><h2 style="text-align:right">Total: ₹${Number(order.total || 0).toLocaleString('en-IN')}</h2><p style="color:#666">Order time: ${emailEscape(order.confirmedAtText || 'Just now')}</p></div></div>`
  };

  try {
    await transporter.verify();
    const info = await transporter.sendMail(message);
    console.info('ORDER_EMAIL_SENT', { orderNumber: order.orderNumber, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error('ORDER_EMAIL_FAILED', {
      orderNumber: order.orderNumber,
      code: error.code || 'UNKNOWN',
      responseCode: error.responseCode || null,
      command: error.command || null,
      message: String(error.message || 'Email send failed').slice(0, 300)
    });
    throw error;
  } finally {
    transporter.close();
  }
}


async function sendCodCancellationNotification(order, reason) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ORDER_NOTIFICATION_EMAIL, MAIL_FROM } = process.env;
  const missing=[];
  if(!SMTP_HOST)missing.push("SMTP_HOST");
  if(!SMTP_PORT)missing.push("SMTP_PORT");
  if(!SMTP_USER)missing.push("SMTP_USER");
  if(!SMTP_PASS)missing.push("SMTP_PASS");
  if(missing.length)throw new Error(`Missing SMTP environment variables: ${missing.join(", ")}`);
  const port=Number(SMTP_PORT);
  if(!Number.isInteger(port)||port<=0)throw new Error("SMTP_PORT must be a valid port number.");
  const transporter=nodemailer.createTransport({host:SMTP_HOST,port,secure:String(SMTP_SECURE||(port===465?"true":"false")).toLowerCase()==="true",auth:{user:SMTP_USER,pass:SMTP_PASS},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
  const items=(order.items||[]).map(x=>`${x.productName||"Product"} | Qty ${Number(x.quantity||0)} | ₹${Number(x.lineTotal||0)}`).join("\n");
  const when=new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
  const text=["COD ORDER CANCELLED – TANMAYI STORE AND GIFTS",`Order: #${order.orderNumber}`,`Customer: ${order.customerName||"Customer"}`,`Mobile: ${order.mobile||""}`,`Reason: ${reason}`,`Cancellation time: ${when}`,"","PRODUCTS:",items||"Product details unavailable.",`Order total: ₹${Number(order.total||0).toLocaleString("en-IN")}`].join("\n");
  try {
    await transporter.verify();
    const info=await transporter.sendMail({from:MAIL_FROM||`TANMAYI STORE AND GIFTS <${SMTP_USER}>`,to:ORDER_NOTIFICATION_EMAIL||SMTP_USER,subject:`COD ORDER CANCELLED – #${order.orderNumber} – TANMAYI STORE AND GIFTS`,text,html:`<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222"><h2 style="background:#171717;color:#d9b45b;padding:20px">TANMAYI STORE AND GIFTS</h2><h3>COD ORDER CANCELLED</h3><p><b>Order:</b> #${emailEscape(order.orderNumber)}<br><b>Customer:</b> ${emailEscape(order.customerName||"Customer")}<br><b>Mobile:</b> ${emailEscape(order.mobile||"")}<br><b>Reason:</b> ${emailEscape(reason)}<br><b>Cancellation time:</b> ${emailEscape(when)}<br><b>Total:</b> ₹${Number(order.total||0).toLocaleString("en-IN")}</p><pre>${emailEscape(items||"Product details unavailable.")}</pre></div>`});
    return {sent:true,messageId:info.messageId||""};
  } finally { transporter.close(); }
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

app.get("/health", (_req, res) => res.json({ ok: true, service: "tanmayi-loyalty-web" }));

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
const OFFER_HOLD_MS = 60 * 60 * 1000;
const MAX_ACTIVE_PRODUCTS = 50;
const PAYMENT_SETTINGS_COLLECTION = "shopPaymentSettings";
const PAYMENT_SUBMISSIONS_COLLECTION = "orderPaymentSubmissions";
const PAYMENT_UTR_KEYS_COLLECTION = "paymentUtrKeys";
const ORDER_REFUNDS_COLLECTION = "orderRefunds";
function decodePaymentImage(dataUrl, label) {
  if (typeof dataUrl !== "string") throw new Error(`${label} image is required.`);
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error(`${label} must be uploaded as an image.`);
  if (dataUrl.length > 360000) throw new Error(`${label} is too large. Please choose a smaller image.`);
  return dataUrl;
}
function decodeImage(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Both product photos are required.");
  const match = dataUrl.match(/^data:image\/(jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("Upload valid JPG, PNG or WEBP photos. Photos are converted to compressed JPG before saving.");
  // Keep each image below 360 KB so both photos fit safely inside Firestore's 1 MiB document limit.
  if (dataUrl.length > 360000) throw new Error("Photo is too large after compression. Please choose a smaller image.");
  return dataUrl;
}
// Shop-owned UPI QR settings. Only active admins can replace the QR image.
app.get("/api/admin/payment-settings", requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection(PAYMENT_SETTINGS_COLLECTION).doc("upi").get();
    res.json({ qrData: snap.exists ? String(snap.data().qrData || "") : "", updatedAt: snap.exists ? safeDate(snap.data().updatedAt) : null });
  } catch (e) { res.status(500).json({ error:"Could not load payment QR settings." }); }
});
app.put("/api/admin/payment-settings", requireAdmin, async (req, res) => {
  try {
    const qrData = decodePaymentImage(req.body?.qrData, "Payment QR");
    await db.collection(PAYMENT_SETTINGS_COLLECTION).doc("upi").set({
      qrData, updatedAt:admin.firestore.FieldValue.serverTimestamp(), updatedBy:req.adminUid
    }, { merge:true });
    res.json({ ok:true, message:"Online payment QR code updated successfully." });
  } catch (e) { res.status(400).json({ error:e.message || "Could not update payment QR." }); }
});

// Signed Cloudinary uploads keep large image binaries out of Firestore.
app.post("/api/admin/promotion-upload-signature", requireAdmin, (req, res) => {
  try {
    let { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
    // Support Render's standard CLOUDINARY_URL as well as separate variables.
    if ((!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) && process.env.CLOUDINARY_URL) {
      try {
        const cloudinaryUrl = new URL(process.env.CLOUDINARY_URL);
        CLOUDINARY_CLOUD_NAME = CLOUDINARY_CLOUD_NAME || cloudinaryUrl.hostname;
        CLOUDINARY_API_KEY = CLOUDINARY_API_KEY || decodeURIComponent(cloudinaryUrl.username);
        CLOUDINARY_API_SECRET = CLOUDINARY_API_SECRET || decodeURIComponent(cloudinaryUrl.password);
      } catch {
        return res.status(503).json({ error: "CLOUDINARY_URL is invalid. Check its cloudinary://API_KEY:API_SECRET@CLOUD_NAME format in Render." });
      }
    }
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(503).json({ error: "Cloudinary is not configured. Add CLOUDINARY_URL or all three separate Cloudinary variables to the Render backend environment." });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "tanmayi-promotions";
    const signatureBase = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash("sha1").update(signatureBase).digest("hex");
    res.json({ cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, timestamp, folder, signature });
  } catch (e) {
    console.error("[PROMOTION_UPLOAD] Signature generation failed:", e.message);
    res.status(500).json({ error: "Could not prepare secure photo upload." });
  }
});

// Customer-facing WhatsApp contact and dashboard promotion images.
const STORE_SETTINGS_COLLECTION = "storeSettings";
function sendStoreSettings(res, d, source) {
  const payload = {
    whatsappNumber: String(d.whatsappNumber || "7899066113"),
    promotionPhotos: Array.isArray(d.promotionPhotos) ? d.promotionPhotos.slice(0, 5) : [],
    updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : null
  };
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Surrogate-Control": "no-store"
  });
  console.log("[STORE_SETTINGS] GET " + source, {
    whatsappLast4: payload.whatsappNumber.slice(-4),
    photoCount: payload.promotionPhotos.length,
    updatedAt: payload.updatedAt
  });
  return res.json(payload);
}
app.get("/api/admin/store-settings", requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection(STORE_SETTINGS_COLLECTION).doc("public").get();
    return sendStoreSettings(res, snap.exists ? snap.data() : {}, "admin");
  } catch (e) { console.error("[STORE_SETTINGS] Admin GET failed:", e.message); res.status(500).json({ error: "Could not load store settings." }); }
});
app.get("/api/customer/store-settings", async (_req, res) => {
  try {
    const snap = await db.collection(STORE_SETTINGS_COLLECTION).doc("public").get();
    return sendStoreSettings(res, snap.exists ? snap.data() : {}, "customer");
  } catch (e) { console.error("[STORE_SETTINGS] Customer GET failed:", e.message); res.status(500).json({ error: "Could not load store settings." }); }
});
app.put("/api/admin/store-settings", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  console.log("[STORE_SETTINGS] PUT received", {
    adminUid: req.adminUid || "unknown",
    hasWhatsAppNumber: Object.prototype.hasOwnProperty.call(req.body || {}, "whatsappNumber"),
    photoCount: Array.isArray(req.body?.promotionPhotos) ? req.body.promotionPhotos.length : 0,
    photoLengths: Array.isArray(req.body?.promotionPhotos) ? req.body.promotionPhotos.map(p => typeof p === "string" ? p.length : -1) : []
  });
  try {
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.adminUid };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "whatsappNumber")) {
      const number = String(req.body.whatsappNumber || "").trim();
      if (!/^\d{10}$/.test(number)) return res.status(400).json({ error: "Enter a valid 10-digit WhatsApp number." });
      update.whatsappNumber = number;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "promotionPhotos")) {
      const photos = req.body.promotionPhotos;
      if (!Array.isArray(photos) || photos.length > 5) return res.status(400).json({ error: "Upload up to 5 promotion photos." });
      for (const photo of photos) {
        let valid = false;
        try {
          const url = new URL(photo);
          valid = url.protocol === "https:" && url.hostname === "res.cloudinary.com" && url.pathname.includes("/image/upload/");
        } catch {}
        if (typeof photo !== "string" || !valid || photo.length > 2000) {
          return res.status(400).json({ error: "Promotion photos must be secure Cloudinary image URLs. Upload the photos again." });
        }
      }
      update.promotionPhotos = photos;
    }
    if (!("whatsappNumber" in update) && !("promotionPhotos" in update)) return res.status(400).json({ error: "No store settings supplied." });
    const settingsRef = db.collection(STORE_SETTINGS_COLLECTION).doc("public");
    await settingsRef.set(update, { merge: true });
    const verifySnap = await settingsRef.get();
    const saved = verifySnap.exists ? verifySnap.data() : {};
    const savedPhotos = Array.isArray(saved.promotionPhotos) ? saved.promotionPhotos.slice(0, 5) : [];
    const savedNumber = String(saved.whatsappNumber || "7899066113");
    const numberMatches = !Object.prototype.hasOwnProperty.call(update, "whatsappNumber") || savedNumber === update.whatsappNumber;
    const photosMatch = !Object.prototype.hasOwnProperty.call(update, "promotionPhotos") || JSON.stringify(savedPhotos) === JSON.stringify(update.promotionPhotos);
    console.log("[STORE_SETTINGS] Save verified", {
      photoCount: savedPhotos.length,
      whatsappLast4: savedNumber.slice(-4),
      whatsappUpdated: Object.prototype.hasOwnProperty.call(update, "whatsappNumber"),
      numberMatches,
      photosMatch,
      elapsedMs: Date.now() - startedAt
    });
    if (!numberMatches || !photosMatch) return res.status(500).json({ error: "Settings write could not be verified. Please retry." });
    res.set({ "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate", "Pragma": "no-cache", "Expires": "0" });
    res.json({ ok: true, message: "Store settings saved and verified.", whatsappNumber: savedNumber, promotionPhotos: savedPhotos });
  } catch (e) {
    console.error("[STORE_SETTINGS] Save failed", { message: e.message, code: e.code, stack: e.stack, elapsedMs: Date.now() - startedAt });
    res.status(400).json({ error: e.message || "Could not save store settings." });
  }
});

app.get("/api/customer/payment-settings", requireUser, async (_req, res) => {
  try {
    const snap = await db.collection(PAYMENT_SETTINGS_COLLECTION).doc("upi").get();
    res.json({ qrData: snap.exists ? String(snap.data().qrData || "") : "" });
  } catch (e) { res.status(500).json({ error:"Could not load shop payment QR." }); }
});

app.get("/api/admin/products", requireAdmin, async (_req, res) => {
  try {
    const [snap, reservationSnap] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).orderBy("createdAt", "desc").get(),
      db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get()
    ]);
    const now = Date.now(), heldByProduct = new Map();
    reservationSnap.docs.forEach(r => {
      const x = r.data();
      if (x.orderId || asMillis(x.expiresAt) > now) heldByProduct.set(x.productId, (heldByProduct.get(x.productId) || 0) + 1);
    });
    res.json({ products: snap.docs.map(d => {
      const x=d.data(), stock=Number.isInteger(Number(x.stock)) ? Number(x.stock) : 0;
      const reservedCount=heldByProduct.get(d.id) || 0;
      return { id:d.id, ...x, size:String(x.size||""), description:String(x.description||""), stock, reservedCount, availableStock:Math.max(0, stock-reservedCount),
        photoUrls:Array.isArray(x.photoData)?x.photoData:(Array.isArray(x.photoUrls)?x.photoUrls:[]), createdAt:safeDate(x.createdAt) };
    }) });
  } catch (e) { console.error("admin products", e); res.status(500).json({ error:"Could not load products." }); }
});
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  let productRef;
  try {
    const name = String(req.body?.name || "").trim(), size = String(req.body?.size || "").trim(), description = String(req.body?.description || "").trim(), originalPrice = Number(req.body?.originalPrice), offerPrice = Number(req.body?.offerPrice), stock = Number(req.body?.stock);
    if (size.length > 80 || description.length > 1200) return res.status(400).json({ error:"Product size must be within 80 characters and description within 1200 characters." });
    if (!name || name.length > 80 || !Number.isFinite(originalPrice) || originalPrice <= 0 || !Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice >= originalPrice || !Number.isInteger(stock) || stock < 0) return res.status(400).json({ error:"Enter a product name and valid prices. Offer price must be below original price." });
    const active = await db.collection(PRODUCTS_COLLECTION).where("active", "==", true).get();
    if (active.size >= MAX_ACTIVE_PRODUCTS) return res.status(400).json({ error:"You can keep a maximum of 50 active products. Pause an existing offer first." });
    decodeImage(req.body?.photo1); decodeImage(req.body?.photo2);
    productRef = db.collection(PRODUCTS_COLLECTION).doc();
    const photoData = [decodeImage(req.body.photo1), decodeImage(req.body.photo2)];
    await productRef.set({ name, size, description, originalPrice, offerPrice, stock, photoData, active:true, createdAt:admin.firestore.FieldValue.serverTimestamp(), updatedAt:admin.firestore.FieldValue.serverTimestamp(), createdBy:req.adminUid });
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

    const hasProductEdit = ["name", "size", "description", "originalPrice", "offerPrice"].some(k => req.body?.[k] !== undefined);
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
    if (req.body?.size !== undefined) {
      const size = String(req.body.size || "").trim();
      if (size.length > 80) return res.status(400).json({ error:"Product size must be within 80 characters." });
      updates.size = size;
    }
    if (req.body?.description !== undefined) {
      const description = String(req.body.description || "").trim();
      if (description.length > 1200) return res.status(400).json({ error:"Product description must be within 1200 characters." });
      updates.description = description;
    }

    if (req.body?.stock !== undefined) {
      const stock = Number(req.body.stock);
      if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return res.status(400).json({ error:"Stock must be a whole number from 0 to 100000." });
      const reservations = await db.collection(RESERVATIONS_COLLECTION).where("productId", "==", req.params.id).get();
      const held = reservations.docs.filter(d => d.data().status === "active" && (Boolean(d.data().orderId) || asMillis(d.data().expiresAt) > Date.now())).length;
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
      const held = heldSnap.docs.filter(r => r.data().status === "active" && (Boolean(r.data().orderId) || asMillis(r.data().expiresAt) > now)).length;
      const stock = Number.isInteger(Number(x.stock)) ? Number(x.stock) : 0;
      products.push({ id:d.id, name:x.name, size:String(x.size||""), description:String(x.description||""), originalPrice:moneyNumber(x.originalPrice), offerPrice:moneyNumber(x.offerPrice), stock, availableStock:Math.max(0, stock-held), photoUrls:Array.isArray(x.photoData)?x.photoData:(Array.isArray(x.photoUrls)?x.photoUrls:[]) });
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
      const held = existing.docs.filter(d => d.data().status === "active" && (Boolean(d.data().orderId) || asMillis(d.data().expiresAt) > now)).length;
      if (held >= stock) throw new Error("Sorry, this product is out of stock or all pieces are currently selected.");
      const expiresAt = now + OFFER_HOLD_MS;
      tx.create(reservationRef, { customerUid:req.user.uid, productId, productName:product.data().name, offerPrice:moneyNumber(product.data().offerPrice), status:"active", createdAt:admin.firestore.FieldValue.serverTimestamp(), expiresAt:admin.firestore.Timestamp.fromMillis(expiresAt) });
      result = { id:reservationRef.id, expiresAt };
    });
    res.json({ ok:true, reservation:result });
  } catch (e) { res.status(400).json({ error:e.message || "Could not select this offer." }); }
});

// Customer confirms the staged cart. Confirmed orders remain active until the shop
// cancels or completes them; the one-hour expiry applies only to unconfirmed selections. Packing is done in-store
// when the customer arrives; the website does not mark cash paid or award stamps here.
app.post("/api/customer/confirm-offers", requireUser, async (req, res) => {
  let createdOrder = null;
  let isDuplicateRequest = false;
  try {
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds.map(x => String(x || "")).filter(Boolean) : [];
    const clientRequestId = String(req.body?.clientRequestId || "");
    const paymentMethod = String(req.body?.paymentMethod || "CASH_ON_DELIVERY");
    const paymentUtr = String(req.body?.paymentUtr || "").replace(/[^0-9]/g, "");
    const paymentScreenshot = req.body?.paymentScreenshot;
    const fulfilmentMode = String(req.body?.fulfilmentMode || "SHOP_COLLECTION");
    const deliveryAddress = req.body?.deliveryAddress || {};
    const customerLatitude = Number(req.body?.customerLatitude), customerLongitude = Number(req.body?.customerLongitude);
    if (!["SHOP_COLLECTION", "HOME_DELIVERY"].includes(fulfilmentMode)) return res.status(400).json({error:"Choose a valid delivery option."});
    if (fulfilmentMode === "HOME_DELIVERY") {
      if (!/^\d{10}$/.test(String(deliveryAddress.mobile||"")) || !String(deliveryAddress.name||"").trim() || !String(deliveryAddress.address||"").trim() || !String(deliveryAddress.area||"").trim() || !String(deliveryAddress.landmark||"").trim() || String(deliveryAddress.pincode||"") !== "517408") return res.status(400).json({error:"Home delivery not available at this location or pincode. Check all address fields and PIN 517408."});
      if (!Number.isFinite(customerLatitude) || !Number.isFinite(customerLongitude) || customerLatitude < -90 || customerLatitude > 90 || customerLongitude < -180 || customerLongitude > 180) return res.status(400).json({error:"Please share your current GPS location to check delivery availability."});
      const rad = n => n * Math.PI / 180;
      const dLat = rad(customerLatitude - 13.217485), dLon = rad(customerLongitude - 78.738013);
      const h = Math.sin(dLat/2)**2 + Math.cos(rad(13.217485))*Math.cos(rad(customerLatitude))*Math.sin(dLon/2)**2;
      const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
      if (distanceKm > 12) return res.status(400).json({error:"Home delivery not available at this location or pincode. Delivery is available only within 12 km of the shop."});
    }
    if (!["CASH_ON_DELIVERY", "ONLINE_PAYMENT"].includes(paymentMethod)) return res.status(400).json({ error:"Choose a valid payment method." });
    if (fulfilmentMode === "HOME_DELIVERY" && paymentMethod !== "ONLINE_PAYMENT") return res.status(400).json({error:"Home delivery is available with Online Payment only. Cash on Delivery is available only for Visit Shop & Collect."});
    if (paymentMethod === "ONLINE_PAYMENT") {
      if (paymentUtr.length !== 12) return res.status(400).json({ error:`UTR must contain exactly 12 digits. Server received ${paymentUtr.length} digit(s).` });
      decodePaymentImage(paymentScreenshot, "Payment screenshot");
    }
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
    const paymentSubmissionRef = db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(orderRef.id);
    const utrKeyRef = paymentMethod === "ONLINE_PAYMENT" ? db.collection(PAYMENT_UTR_KEYS_COLLECTION).doc(paymentUtr) : null;

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
      if (utrKeyRef) {
        const utrSnap = await tx.get(utrKeyRef);
        if (utrSnap.exists) throw new Error("This UTR number has already been submitted. Please check the number or contact the shop.");
      }
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
        const held = existingByProduct.get(id).docs.filter(d => d.data().status === "active" && (Boolean(d.data().orderId) || asMillis(d.data().expiresAt) > now)).length;
        if (held + quantity > stock) throw new Error(`${product.name || "A selected product"} has only ${Math.max(0, stock-held)} piece(s) available now. Please update your selection.`);
      }

      const expiresAt = now + OFFER_HOLD_MS;
      const customer = customerSnap.data();
      const items = [...quantities.entries()].map(([id, quantity]) => {
        const product = productSnaps.get(id).data();
        const offerPrice = moneyNumber(product.offerPrice);
        return { productId:id, productName:product.name || "Product", size:String(product.size||""), description:String(product.description||""), quantity, offerPrice, lineTotal:offerPrice * quantity,
          photoUrls:Array.isArray(product.photoData) ? product.photoData : (Array.isArray(product.photoUrls) ? product.photoUrls : []) };
      });
      const productTotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const deliveryCharge = fulfilmentMode === "HOME_DELIVERY" ? 49 : 0;
      const total = productTotal + deliveryCharge;
      const orderNumber = Number(counterSnap.exists ? counterSnap.data().lastOrderNumber || 10000 : 10000) + 1;
      const confirmedAt = admin.firestore.FieldValue.serverTimestamp();
      const orderData = {
        orderNumber, customerUid:req.user.uid,
        customerName:String(customer.name || "Customer"), mobile:String(customer.mobile || ""), village:String(customer.village || ""),
        items, productTotal, deliveryCharge, total, paymentMethod,
        fulfilmentMode,
        deliveryAddress:fulfilmentMode === "HOME_DELIVERY" ? {name:String(deliveryAddress.name).trim(),mobile:String(deliveryAddress.mobile),address:String(deliveryAddress.address).trim(),area:String(deliveryAddress.area).trim(),landmark:String(deliveryAddress.landmark).trim(),pincode:"517408",latitude:customerLatitude,longitude:customerLongitude} : null,
        paymentUtr: paymentMethod === "ONLINE_PAYMENT" ? paymentUtr : "",
        orderStatus:"ready", collectionStatus:"pending",
        paymentStatus: paymentMethod === "ONLINE_PAYMENT" ? "submitted" : "pending",
        stampsStatus:"pending",
        createdAt:confirmedAt, confirmedAt, readyAt:confirmedAt,
        emailStatus:"pending", createdByCustomer:true
      };
      tx.create(orderRef, orderData);
      if (fulfilmentMode === "HOME_DELIVERY") tx.set(customerRef(req.user.uid), {deliveryAddress:orderData.deliveryAddress}, {merge:true});
      if (paymentMethod === "ONLINE_PAYMENT") {
        tx.create(paymentSubmissionRef, {
          orderId:orderRef.id, orderNumber, customerUid:req.user.uid,
          utr:paymentUtr, screenshotData:paymentScreenshot,
          status:"submitted", submittedAt:confirmedAt
        });
        tx.create(utrKeyRef, { orderId:orderRef.id, customerUid:req.user.uid, createdAt:confirmedAt });
      }
      tx.set(counterRef, { lastOrderNumber:orderNumber, updatedAt:admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
      tx.create(requestRef, { orderId:orderRef.id, customerUid:req.user.uid, createdAt:admin.firestore.FieldValue.serverTimestamp() });
      productIds.forEach((id, index) => {
        const product = productSnaps.get(id).data();
        tx.create(reservationRefs[index], {
          customerUid:req.user.uid, productId:id, productName:product.name || "Product",
          offerPrice:moneyNumber(product.offerPrice), orderId:orderRef.id, orderNumber,
          status:"active", createdAt:confirmedAt, orderId:orderRef.id, orderNumber
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
    res.json({ ok:true, order:{ id:createdOrder.id, orderNumber:createdOrder.orderNumber, total:createdOrder.total, expiresAt:asMillis(createdOrder.expiresAt), orderStatus:createdOrder.orderStatus }, emailSent, emailStatus:createdOrder.emailStatus, duplicateRequest:isDuplicateRequest });
  } catch (e) { console.error("confirm offers", e); res.status(400).json({ error:e.message || "Could not confirm your order." }); }
});

// Customer order history, including the completed order and stamp confirmation.
app.get("/api/customer/my-orders", requireUser, async (req, res) => {
  try {
    const snap = await db.collection(ORDERS_COLLECTION).where("customerUid", "==", req.user.uid).get();
    const [paymentDocs, refundDocs] = await Promise.all([
      Promise.all(snap.docs.map(d=>db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(d.id).get())),
      Promise.all(snap.docs.map(d=>db.collection(ORDER_REFUNDS_COLLECTION).doc(d.id).get()))
    ]);
    const paymentById=new Map(paymentDocs.filter(d=>d.exists).map(d=>[d.id,d.data()]));
    const refundById=new Map(refundDocs.filter(d=>d.exists).map(d=>[d.id,d.data()]));
    const orders = snap.docs.map(d => {
      const x=d.data(),payment=paymentById.get(d.id)||{},refund=refundById.get(d.id)||{};
      return { id:d.id, orderNumber:x.orderNumber, items:x.items || [], total:moneyNumber(x.total), paymentMethod:x.paymentMethod || "CASH_ON_DELIVERY", paymentStatus:x.paymentStatus || "pending", paymentUtr:x.paymentUtr || payment.utr || "",
        paymentScreenshotData:x.orderStatus === "cancelled" ? (payment.screenshotData || "") : "",
        refund:refund.status ? {status:refund.status,holderName:refund.holderName||"",upiId:refund.upiId||"",refundUtr:refund.refundUtr||"",customerMessage:refund.customerMessage||"",message:refund.message||"",screenshotData:refund.screenshotData||"",updatedAt:safeDate(refund.updatedAt)} : null,
        orderStatus:(x.orderStatus || "ready"), collectionStatus:x.collectionStatus || "pending",
        stampsStatus:x.stampsStatus || "pending", stampsAdded:moneyNumber(x.stampsAdded), confirmedAt:safeDate(x.confirmedAt || x.createdAt),
        fulfilmentMode:x.fulfilmentMode || "SHOP_COLLECTION", deliveryCharge:moneyNumber(x.deliveryCharge), deliveryAddress:x.deliveryAddress || null, paymentVerifiedAt:safeDate(x.paymentVerifiedAt),
        cancelledAt:safeDate(x.cancelledAt), readyAt:safeDate(x.readyAt), completedAt:safeDate(x.completedAt), expiresAt:asMillis(x.expiresAt) };
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
    let refundRequested=false;
    let refundEmailPayload=null;
    let codCancellationPayload=null;
    await db.runTransaction(async tx => {
      const orderSnap=await tx.get(orderRef);
      if (!orderSnap.exists || orderSnap.data().customerUid !== req.user.uid) throw new Error("You cannot cancel this order.");
      const order=orderSnap.data();
      if (order.orderStatus === "cancelled") return;
      if (order.orderStatus === "completed" || order.collectionStatus === "collected") throw new Error("This order can no longer be cancelled online. Please contact the shop.");
      const online=order.paymentMethod === "ONLINE_PAYMENT";
      if(!online && order.paymentMethod === "CASH_ON_DELIVERY") codCancellationPayload={...order, id:orderId};
      let holderName="",upiId="";
      if(online){
        holderName=String(req.body?.holderName||"").trim().slice(0,100);
        upiId=String(req.body?.upiId||"").trim().slice(0,100);
        if(!holderName||!upiId) throw new Error("Enter bank account holder name and UPI ID / number to request a refund.");
        if(!["submitted","received"].includes(order.paymentStatus)) throw new Error("Online payment has not been submitted. Please contact the shop.");
        const refundRef=db.collection(ORDER_REFUNDS_COLLECTION).doc(orderId);
        const existingRefund=await tx.get(refundRef);
        if(existingRefund.exists && ["requested","processing","success"].includes(existingRefund.data().status)) throw new Error("A refund request already exists for this order.");
      }
      const refundRef=db.collection(ORDER_REFUNDS_COLLECTION).doc(orderId);
      const reservations=await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId","==",orderId));
      if(online){
        const holderName=String(req.body?.holderName||"").trim().slice(0,100),upiId=String(req.body?.upiId||"").trim().slice(0,100);
        const paymentSnap=await tx.get(db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(orderId));
        tx.set(refundRef,{orderId,orderNumber:order.orderNumber,customerUid:req.user.uid,customerName:order.customerName||"Customer",mobile:order.mobile||"",holderName,upiId,status:"requested",customerMessage:"Refund requested by customer",requestedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp(),emailStatus:"pending"},{merge:true});
        refundEmailPayload={refund:{orderNumber:order.orderNumber,customerName:order.customerName||"Customer",mobile:order.mobile||"",holderName,upiId},order:{...order},paymentScreenshotData:paymentSnap.exists?(paymentSnap.data().screenshotData||""):""};
        refundRequested=true;
      }
      reservations.docs.filter(d=>d.data().status === "active").forEach(d=>tx.update(d.ref,{status:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp()}));
      tx.update(orderRef,{orderStatus:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp(),customerCancelled:true,...(online?{refundStatus:"requested"}:{})});
    });
    let codCancellationEmailSent=false;
    if(codCancellationPayload){
      try{
        const mail=await sendCodCancellationNotification(codCancellationPayload,"Customer cancelled the COD order.");
        codCancellationEmailSent=mail.sent;
        await orderRef.update({cancellationEmailStatus:"sent",cancellationEmailMessageId:mail.messageId||"",cancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
      }catch(mailError){
        console.error("COD cancellation email failed:",mailError);
        await orderRef.update({cancellationEmailStatus:"failed",cancellationEmailError:String(mailError.message||"Email failed").slice(0,250),cancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()}).catch(()=>{});
      }
    }
    let refundEmailSent=false;
    if(refundRequested && refundEmailPayload){
      const refundRef=db.collection(ORDER_REFUNDS_COLLECTION).doc(orderId);
      try{
        const mail=await sendRefundRequestNotification(refundEmailPayload.refund,refundEmailPayload.order,refundEmailPayload.paymentScreenshotData);
        refundEmailSent=mail.sent;
        await refundRef.update({emailStatus:"sent",emailMessageId:mail.messageId||"",emailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
      }catch(mailError){
        console.error("refund request email failed:",mailError);
        await refundRef.update({emailStatus:"failed",emailError:String(mailError.message||"Email failed").slice(0,250),emailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()}).catch(()=>{});
      }
    }
    res.json({ok:true,refundRequested,codCancellationEmailSent,message:refundRequested?"Order cancelled. Your refund request has been submitted to the shop.":"Order cancelled successfully."});
  } catch(e) { res.status(400).json({error:e.message || "Could not cancel this order."}); }
});

// Admin records a refund UTR, proof screenshot, or an issue explanation for the customer.
// No separate FAILED state: a refund becomes SUCCESS only when both UTR and proof are supplied.
app.post("/api/admin/orders/:id/refund", requireAdmin, async (req,res)=>{
  try{
    const message=String(req.body?.message||"").trim().slice(0,500);
    const refundUtr=String(req.body?.refundUtr||"").replace(/\D/g,"").slice(0,12);
    const screenshotData=req.body?.screenshotData||"";
    if(!message) throw new Error("Enter a message for the customer.");
    if(refundUtr && !/^\d{12}$/.test(refundUtr)) throw new Error("Refund UTR must contain exactly 12 digits.");
    if(screenshotData) decodePaymentImage(screenshotData,"Refund payment / issue screenshot");
    if(refundUtr && !screenshotData) throw new Error("For a successful refund, provide both the 12-digit refund UTR and refund payment screenshot.");
    const status=refundUtr && screenshotData ? "success" : "requested";
    const orderRef=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    const refundRef=db.collection(ORDER_REFUNDS_COLLECTION).doc(req.params.id);
    await db.runTransaction(async tx=>{
      const [orderSnap,refundSnap]=await Promise.all([tx.get(orderRef),tx.get(refundRef)]);
      if(!orderSnap.exists) throw new Error("Order not found.");
      const order=orderSnap.data();
      if(order.paymentMethod!=="ONLINE_PAYMENT" || order.orderStatus!=="cancelled") throw new Error("Refund is available only for cancelled online payment orders.");
      if(!refundSnap.exists) throw new Error("Customer refund request was not found.");
      const old=refundSnap.data();
      if(old.status==="success") throw new Error("This refund is already marked successful.");
      tx.set(refundRef,{status,message,refundUtr:refundUtr||old.refundUtr||"",screenshotData:screenshotData||old.screenshotData||"",updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:req.adminUid,successAt:status==="success"?admin.firestore.FieldValue.serverTimestamp():null},{merge:true});
      tx.update(orderRef,{refundStatus:status,refundUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    res.json({ok:true,status,message:status==="success"?"Refund marked successful. Refund UTR and screenshot are now visible to the customer.":"Refund update saved. Your message and any issue screenshot are visible to the customer."});
  }catch(e){res.status(400).json({error:e.message||"Could not update refund details."});}
});


app.post("/api/admin/orders/:id/cancel-cod", requireAdmin, async (req,res)=>{
  try{
    const orderRef=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    let cancelledOrder=null;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(orderRef);
      if(!snap.exists)throw new Error("Order not found.");
      const order=snap.data();
      if(order.paymentMethod!=="CASH_ON_DELIVERY")throw new Error("Admin cancellation here is only for Cash on Delivery orders.");
      if(["completed","cancelled","expired"].includes(order.orderStatus)||order.collectionStatus==="collected")throw new Error("This COD order can no longer be cancelled.");
      const reservations=await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId","==",req.params.id));
      reservations.docs.filter(d=>d.data().status==="active").forEach(d=>tx.update(d.ref,{status:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp(),cancelReason:"admin_cancelled"}));
      tx.update(orderRef,{orderStatus:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp(),customerCancelled:false,cancelledByAdmin:true,cancelReason:"admin_cancelled",cancellationEmailStatus:"pending"});
      cancelledOrder={...order,id:req.params.id};
    });
    if(!cancelledOrder)return res.json({ok:true,message:"Order was already cancelled."});
    let emailSent=false;
    try{
      const mail=await sendCodCancellationNotification(cancelledOrder,"Cancelled by shop admin.");
      emailSent=mail.sent;
      await orderRef.update({cancellationEmailStatus:"sent",cancellationEmailMessageId:mail.messageId||"",cancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
    }catch(mailError){
      console.error("Admin COD cancellation email failed:",mailError);
      await orderRef.update({cancellationEmailStatus:"failed",cancellationEmailError:String(mailError.message||"Email failed").slice(0,250),cancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()}).catch(()=>{});
    }
    res.json({ok:true,emailSent,message:emailSent?"COD order cancelled and notification email sent.":"COD order cancelled. Email could not be sent; check Render SMTP settings."});
  }catch(e){res.status(400).json({error:e.message||"Could not cancel COD order."});}
});

// Admin dashboard order API. Response fields match the Admin HTML dashboard.
app.get("/api/admin/offer-orders", requireAdmin, async (_req, res) => {
  try {
    const [snap, paymentSnap, refundSnap] = await Promise.all([
      db.collection(ORDERS_COLLECTION).get(),
      db.collection(PAYMENT_SUBMISSIONS_COLLECTION).get(),
      db.collection(ORDER_REFUNDS_COLLECTION).get()
    ]);
    const paymentByOrder = new Map(paymentSnap.docs.map(d => [d.id, d.data()]));
    const refundByOrder = new Map(refundSnap.docs.map(d => [d.id, d.data()]));
    const now = Date.now();
    const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
    const rawOrders = snap.docs.map(d => ({ id:d.id, data:d.data() }));
    // Older orders may not contain a photo snapshot. Load their current product photos
    // as a fallback, while new orders keep the photo snapshot saved at order time.
    const missingPhotoProductIds = [...new Set(rawOrders.flatMap(({data}) =>
      (Array.isArray(data.items) ? data.items : [])
        .filter(item => !Array.isArray(item.photoUrls) || !item.photoUrls.length)
        .map(item => String(item.productId || "")).filter(Boolean)
    ))];
    const photoProductDocs = await Promise.all(missingPhotoProductIds.map(id => db.collection(PRODUCTS_COLLECTION).doc(id).get()));
    const productPhotos = new Map(photoProductDocs.filter(d => d.exists).map(d => {
      const p=d.data();
      return [d.id, Array.isArray(p.photoData) ? p.photoData : (Array.isArray(p.photoUrls) ? p.photoUrls : [])];
    }));
    const all = rawOrders.map(({id, data:x}) => {
      const confirmedAt = safeDate(x.confirmedAt || x.createdAt);
      const expiresAt = asMillis(x.expiresAt);
      const effectiveStatus = x.orderStatus || "ready";
      const items = (Array.isArray(x.items) ? x.items : []).map(item => ({
        ...item,
        photoUrls:Array.isArray(item.photoUrls) && item.photoUrls.length
          ? item.photoUrls
          : (productPhotos.get(String(item.productId || "")) || [])
      }));
      const payment = paymentByOrder.get(id) || {};
      return { id, ...x, confirmedAt, expiresAt, orderStatus:effectiveStatus,
        total:moneyNumber(x.total), items,
        paymentUtr:x.paymentUtr || payment.utr || "",
        paymentScreenshotData:(payment.status === "submitted" || refundByOrder.has(id)) ? (payment.screenshotData || "") : "",
        paymentSubmissionStatus:payment.status || "",
        refund:refundByOrder.get(id) || null,
        customerName:x.customerName || "Customer", mobile:x.mobile || "" };
    }).sort((a,b) => new Date(b.confirmedAt || 0) - new Date(a.confirmedAt || 0));
    const keyOf = x => x.confirmedAt ? new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(x.confirmedAt)) : "";
    const today = all.filter(x => keyOf(x) === todayKey);
    const runningOrders = all.filter(x => !["completed", "cancelled", "expired"].includes(x.orderStatus));
    const completedOrdersList = all.filter(x => x.orderStatus === "completed");
    const cancelledOrders = all.filter(x => ["cancelled", "expired"].includes(x.orderStatus)).slice(0, 2);
    const todayCustomersMap = new Map();
    for (const x of today) {
      const key = x.customerUid || x.mobile || x.customerName;
      const current = todayCustomersMap.get(key) || { name:x.customerName, mobile:x.mobile, count:0 };
      current.count += 1;
      todayCustomersMap.set(key, current);
    }
    res.json({
      orders:all, runningOrders, completedOrdersList, cancelledOrders,
      todayCustomers:[...todayCustomersMap.values()],
      stats:{ newOrders:runningOrders.filter(x=>x.collectionStatus !== "collected").length,
        oldOrders:all.filter(x=>["expired", "cancelled"].includes(x.orderStatus)).length,
        completedOrders:completedOrdersList.length, todayOrders:today.length,
        pendingToday:today.filter(x=>x.orderStatus !== "completed" && x.orderStatus !== "cancelled" && x.orderStatus !== "expired").length,
        completedToday:today.filter(x=>x.orderStatus === "completed").length }
    });
  } catch(e) { console.error("admin offer orders",e); res.status(500).json({error:"Could not load customer orders."}); }
});

app.post("/api/admin/orders/:id/verify-payment", requireAdmin, async (req,res)=>{
  try {
    const ref=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists) throw new Error("Order not found.");
      const x=snap.data();
      if(x.paymentMethod !== "ONLINE_PAYMENT") throw new Error("This order is not an online payment order.");
      if(x.paymentStatus === "received") return;
      if(x.paymentStatus !== "submitted") throw new Error("No online payment submission is waiting for verification.");
      const paymentRef=db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(req.params.id);
      const paymentSnap=await tx.get(paymentRef);
      if(!paymentSnap.exists || paymentSnap.data().status !== "submitted") throw new Error("Payment screenshot or submission record is missing.");
      tx.update(ref,{paymentStatus:"received",paymentVerifiedAt:admin.firestore.FieldValue.serverTimestamp(),paymentVerifiedBy:req.adminUid});
      tx.update(paymentRef,{status:"verified",verifiedAt:admin.firestore.FieldValue.serverTimestamp(),verifiedBy:req.adminUid});
    });
    res.json({ok:true,message:"Online payment verified. Home delivery orders will be delivered within 1 hour; shop collection orders can be collected at the shop."});
  } catch(e) { res.status(400).json({error:e.message || "Could not verify online payment."}); }
});

app.post("/api/admin/orders/:id/collect", requireAdmin, async (req,res)=>{
  try {
    const ref=db.collection(ORDERS_COLLECTION).doc(req.params.id);
    let onlinePayment = false;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists) throw new Error("Order not found.");
      const x=snap.data();
      onlinePayment = x.paymentMethod === "ONLINE_PAYMENT";
      if(x.orderStatus !== "ready") throw new Error("This order is no longer awaiting collection.");
      if(onlinePayment && x.paymentStatus !== "received") throw new Error("Verify the online payment before marking the product collected.");
      if(x.collectionStatus === "collected") return;
      tx.update(ref,{collectionStatus:"collected",orderStatus:"collected",collectedAt:admin.firestore.FieldValue.serverTimestamp(),collectedBy:req.adminUid});
    });
    res.json({ok:true,message:onlinePayment ? "Product collection marked. Online payment is verified; final approval can now add billing stamps." : "Order collection marked. Next, confirm cash payment."});
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
      const amount=moneyNumber(order.productTotal ?? order.total);
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
app.get("/api/admin/offer-reservations", requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get();
    const now = Date.now();
    const live = snap.docs.filter(d => d.data().orderId || asMillis(d.data().expiresAt) > now);
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


const COD_COLLECTION_DEADLINE_MS=2*60*60*1000;
let codExpiryCheckRunning=false;
async function cancelExpiredCodOrders(){
  if(codExpiryCheckRunning)return;
  codExpiryCheckRunning=true;
  try{
    const snap=await db.collection(ORDERS_COLLECTION).where("paymentMethod","==","CASH_ON_DELIVERY").where("orderStatus","==","ready").get();
    const now=Date.now();
    for(const doc of snap.docs){
      const order=doc.data();
      if(order.collectionStatus==="collected")continue;
      const confirmedAt=asMillis(order.confirmedAt||order.createdAt);
      if(!confirmedAt||now-confirmedAt<COD_COLLECTION_DEADLINE_MS)continue;
      let cancelledOrder=null;
      try{
        await db.runTransaction(async tx=>{
          const current=await tx.get(doc.ref);
          if(!current.exists)return;
          const x=current.data();
          if(x.paymentMethod!=="CASH_ON_DELIVERY"||x.orderStatus!=="ready"||x.collectionStatus==="collected")return;
          const currentConfirmedAt=asMillis(x.confirmedAt||x.createdAt);
          if(!currentConfirmedAt||Date.now()-currentConfirmedAt<COD_COLLECTION_DEADLINE_MS)return;
          const reservations=await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId","==",doc.id));
          reservations.docs.filter(d=>d.data().status==="active").forEach(d=>tx.update(d.ref,{status:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp(),cancelReason:"cod_collection_timeout"}));
          tx.update(doc.ref,{orderStatus:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp(),customerCancelled:false,autoCancelled:true,cancelReason:"cod_collection_timeout",cancellationEmailStatus:"pending"});
          cancelledOrder={...x,id:doc.id};
        });
        if(cancelledOrder){
          try{
            const mail=await sendCodCancellationNotification(cancelledOrder,"Automatically cancelled: the customer did not collect the COD order within 2 hours.");
            await doc.ref.update({cancellationEmailStatus:"sent",cancellationEmailMessageId:mail.messageId||"",cancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
          }catch(mailError){
            console.error("Automatic COD cancellation email failed:",{orderNumber:cancelledOrder.orderNumber,message:mailError.message});
            await doc.ref.update({cancellationEmailStatus:"failed",cancellationEmailError:String(mailError.message||"Email failed").slice(0,250),cancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()}).catch(()=>{});
          }
        }
      }catch(orderError){console.error("COD expiry cancellation failed:",doc.id,orderError.message);}
    }
  }catch(error){console.error("COD expiry scan failed:",error.message);}
  finally{codExpiryCheckRunning=false;}
}

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => console.log(`TANMAYI LOYALTY WEB listening on ${port}`));
setTimeout(()=>cancelExpiredCodOrders(),10000);
setInterval(()=>cancelExpiredCodOrders(),60000).unref?.();

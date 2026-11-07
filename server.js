const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));

// Public SEO endpoints for Google Search Console. Keep these before application routes.
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://tanmayistore.com/sitemap.xml\n");
});
app.get("/sitemap.xml", (_req, res) => {
  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    '  <url><loc>https://tanmayistore.com/</loc></url>\n' +
    '</urlset>\n');
});

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
/**
 * Count only reservations that still hold physical stock.
 * Confirmed reservations stop holding stock once their linked order is
 * completed/collected, cancelled, or expired. Unconfirmed selections use TTL.
 */
async function countHeldReservations(reservationDocs, now, getOrder) {
  const orderIds = [...new Set(reservationDocs
    .map(d => d.data())
    .filter(x => x.status === "active" && x.orderId)
    .map(x => String(x.orderId)))];
  const orderSnaps = await Promise.all(orderIds.map(id => getOrder(id)));
  const orderById = new Map(orderSnaps.map(x => [x.id, x]));
  const counts = new Map();
  for (const doc of reservationDocs) {
    const x = doc.data();
    if (x.status !== "active") continue;
    let holds = false;
    if (x.orderId) {
      const order = orderById.get(String(x.orderId));
      // Fail closed if a linked order is unexpectedly missing.
      if (!order || !order.exists) holds = true;
      else {
        const o = order.data();
        holds = !["completed", "cancelled", "expired"].includes(o.orderStatus)
          && o.collectionStatus !== "collected";
      }
    } else {
      holds = asMillis(x.expiresAt) > now;
    }
    if (holds) counts.set(x.productId, (counts.get(x.productId) || 0) + 1);
  }
  return counts;
}


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

async function sendRefundSuccessNotification(refund, order) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ORDER_NOTIFICATION_EMAIL, MAIL_FROM } = process.env;
  const missing = [];
  if (!SMTP_HOST) missing.push("SMTP_HOST");
  if (!SMTP_PORT) missing.push("SMTP_PORT");
  if (!SMTP_USER) missing.push("SMTP_USER");
  if (!SMTP_PASS) missing.push("SMTP_PASS");
  if (missing.length) throw new Error(`Missing SMTP environment variables: ${missing.join(", ")}`);
  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error("SMTP_PORT must be a valid port number.");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port,
    secure: String(SMTP_SECURE || (port === 465 ? "true" : "false")).toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  const itemLines = (order.items || []).map(item => `${item.productName} | Qty ${item.quantity} | ₹${item.lineTotal}`).join("\n");
  const screenshot = String(refund.screenshotData || "");
  const match = screenshot.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  const attachments = match ? [{
    filename: `refund-order-${order.orderNumber}-proof.${match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase()}`,
    content: Buffer.from(match[2], "base64"),
    contentType: `image/${match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase()}`
  }] : [];
  try {
    await transporter.verify();
    const info = await transporter.sendMail({
      from: MAIL_FROM || `TANMAYI STORE AND GIFTS <${SMTP_USER}>`,
      to: ORDER_NOTIFICATION_EMAIL || SMTP_USER,
      subject: `REFUND COMPLETED – Order #${order.orderNumber} – TANMAYI STORE AND GIFTS`,
      text: [
        "TANMAYI STORE AND GIFTS – REFUND SUCCESSFULLY COMPLETED",
        `Order: #${order.orderNumber}`,
        `Customer: ${order.customerName || refund.customerName || "Customer"}`,
        `Mobile: ${order.mobile || refund.mobile || ""}`,
        `Order amount: ₹${Number(order.total || 0).toLocaleString("en-IN")}`,
        `Refund UTR: ${refund.refundUtr || ""}`,
        `Refund date: ${new Date().toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}`,
        `Admin message: ${refund.message || ""}`,
        "", "PRODUCTS:", itemLines || "Product details unavailable.",
        "", "Refund payment proof screenshot is attached."
      ].join("\n"),
      html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222"><h2 style="background:#171717;color:#d9b45b;padding:20px">TANMAYI STORE AND GIFTS</h2><h3>REFUND SUCCESSFULLY COMPLETED</h3><p><b>Order:</b> #${emailEscape(order.orderNumber)}<br><b>Customer:</b> ${emailEscape(order.customerName || refund.customerName || "Customer")}<br><b>Mobile:</b> ${emailEscape(order.mobile || refund.mobile || "")}<br><b>Order amount:</b> ₹${Number(order.total || 0).toLocaleString("en-IN")}<br><b>Refund UTR:</b> ${emailEscape(refund.refundUtr || "")}<br><b>Refund date:</b> ${emailEscape(new Date().toLocaleString("en-IN", {timeZone:"Asia/Kolkata"}))}<br><b>Admin message:</b> ${emailEscape(refund.message || "")}</p><h4>Products</h4><pre>${emailEscape(itemLines || "Product details unavailable.")}</pre><p>Refund payment proof screenshot is attached.</p></div>`,
      attachments
    });
    console.info("REFUND_SUCCESS_EMAIL_SENT", {orderNumber:order.orderNumber,messageId:info.messageId});
    return {sent:true,messageId:info.messageId};
  } catch(error) {
    console.error("REFUND_SUCCESS_EMAIL_FAILED", {orderNumber:order.orderNumber,message:String(error.message || "Email failed").slice(0,300)});
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




async function sendAdminOrderCompletedNotification(order) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ORDER_NOTIFICATION_EMAIL, MAIL_FROM } = process.env;
  const missing=[];
  if(!SMTP_HOST)missing.push("SMTP_HOST");
  if(!SMTP_PORT)missing.push("SMTP_PORT");
  if(!SMTP_USER)missing.push("SMTP_USER");
  if(!SMTP_PASS)missing.push("SMTP_PASS");
  if(missing.length)throw new Error("Missing SMTP environment variables: "+missing.join(", "));
  const port=Number(SMTP_PORT);
  if(!Number.isInteger(port)||port<=0)throw new Error("SMTP_PORT must be a valid port number.");
  const transporter=nodemailer.createTransport({
    host:SMTP_HOST,port,
    secure:String(SMTP_SECURE||(port===465?"true":"false")).toLowerCase()==="true",
    auth:{user:SMTP_USER,pass:SMTP_PASS},
    connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000
  });
  const items=(order.items||[]).map(item=>({
    name:String(item.productName||"Product"),
    quantity:Number(item.quantity||0),
    unitPrice:Number(item.offerPrice||0),
    lineTotal:Number(item.lineTotal||0)
  }));
  const itemText=items.map(x=>x.name+" | Qty "+x.quantity+" | Unit ₹"+x.unitPrice+" | Line ₹"+x.lineTotal).join("\n");
  const itemRows=items.map(x=>"<tr><td style=\"padding:9px;border-bottom:1px solid #eee\">"+emailEscape(x.name)+"</td><td style=\"padding:9px;text-align:center;border-bottom:1px solid #eee\">"+x.quantity+"</td><td style=\"padding:9px;text-align:right;border-bottom:1px solid #eee\">₹"+x.unitPrice.toLocaleString("en-IN")+"</td><td style=\"padding:9px;text-align:right;border-bottom:1px solid #eee\">₹"+x.lineTotal.toLocaleString("en-IN")+"</td></tr>").join("");
  const completedAt=new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
  const text=[
    "TANMAYI STORE AND GIFTS – ORDER COMPLETED",
    "Order: #"+(order.orderNumber||order.id),
    "Customer: "+(order.customerName||"Customer"),
    "Mobile: "+(order.mobile||""),
    "Payment: "+(order.paymentMethod==="ONLINE_PAYMENT"?"ONLINE PAYMENT":"CASH ON DELIVERY"),
    "Payment status: "+(order.paymentStatus||"received"),
    "Products:",itemText||"Product details unavailable.",
    "Total: ₹"+Number(order.total||0).toLocaleString("en-IN"),
    "Stamps added: "+Number(order.stampsAdded||0),
    "Completed at: "+completedAt
  ].join("\n");
  const html="<div style=\"font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222\"><h2 style=\"background:#171717;color:#d9b45b;padding:20px\">TANMAYI STORE AND GIFTS</h2><h3>ORDER COMPLETED SUCCESSFULLY</h3><p><b>Order:</b> #"+emailEscape(order.orderNumber||order.id)+"<br><b>Customer:</b> "+emailEscape(order.customerName||"Customer")+"<br><b>Mobile:</b> "+emailEscape(order.mobile||"")+"<br><b>Payment:</b> "+(order.paymentMethod==="ONLINE_PAYMENT"?"ONLINE PAYMENT":"CASH ON DELIVERY")+"<br><b>Payment status:</b> "+emailEscape(order.paymentStatus||"received")+"</p><table style=\"width:100%;border-collapse:collapse\"><thead><tr><th align=\"left\">Product</th><th>Qty</th><th align=\"right\">Unit Price</th><th align=\"right\">Line Total</th></tr></thead><tbody>"+itemRows+"</tbody></table><h2 style=\"text-align:right\">Total: ₹"+Number(order.total||0).toLocaleString("en-IN")+"</h2><p><b>Stamps added:</b> "+Number(order.stampsAdded||0)+"</p><p>Completed at: "+emailEscape(completedAt)+"</p></div>";
  try{
    await transporter.verify();
    const info=await transporter.sendMail({
      from:MAIL_FROM||("TANMAYI STORE AND GIFTS <"+SMTP_USER+">"),
      to:ORDER_NOTIFICATION_EMAIL||SMTP_USER,
      subject:"ORDER COMPLETED · #"+(order.orderNumber||order.id)+" · TANMAYI STORE AND GIFTS",
      text,html
    });
    console.info("ORDER_COMPLETION_EMAIL_SENT",{orderNumber:order.orderNumber,messageId:info.messageId});
    return {sent:true,messageId:info.messageId};
  }catch(error){
    console.error("ORDER_COMPLETION_EMAIL_FAILED",{orderNumber:order.orderNumber,message:String(error.message||"Email failed").slice(0,300)});
    throw error;
  }finally{transporter.close();}
}

async function sendAdminOrderCancellationNotification(order, reason) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ORDER_NOTIFICATION_EMAIL, MAIL_FROM } = process.env;
  const missing=[];
  if(!SMTP_HOST)missing.push("SMTP_HOST");
  if(!SMTP_PORT)missing.push("SMTP_PORT");
  if(!SMTP_USER)missing.push("SMTP_USER");
  if(!SMTP_PASS)missing.push("SMTP_PASS");
  if(missing.length)throw new Error("Missing SMTP environment variables: "+missing.join(", "));
  const port=Number(SMTP_PORT);
  if(!Number.isInteger(port)||port<=0)throw new Error("SMTP_PORT must be a valid port number.");
  const transporter=nodemailer.createTransport({host:SMTP_HOST,port,secure:String(SMTP_SECURE||(port===465?"true":"false")).toLowerCase()==="true",auth:{user:SMTP_USER,pass:SMTP_PASS},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
  const items=(order.items||[]).map(x=>(x.productName||"Product")+" | Qty "+Number(x.quantity||0)+" | ₹"+Number(x.lineTotal||0)).join("\n");
  const when=new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
  const method=order.paymentMethod==="ONLINE_PAYMENT"?"ONLINE PAYMENT":"CASH ON DELIVERY · VISIT SHOP & COLLECT";
  const text=[
    "ORDER CANCELLED BY ADMIN – TANMAYI STORE AND GIFTS",
    "Order: #"+order.orderNumber,
    "Customer: "+(order.customerName||"Customer"),
    "Mobile: "+(order.mobile||""),
    "Payment method: "+method,
    "Payment status: "+(order.paymentStatus||"pending"),
    "Payment UTR: "+(order.paymentUtr||"Not supplied"),
    "Admin cancellation message: "+reason,
    "Cancellation time: "+when,
    "Order total: ₹"+Number(order.total||0).toLocaleString("en-IN"),
    "",
    "PRODUCTS:",
    items||"Product details unavailable."
  ].join("\n");
  try {
    await transporter.verify();
    const info=await transporter.sendMail({
      from:MAIL_FROM||("TANMAYI STORE AND GIFTS <"+SMTP_USER+">"),
      to:ORDER_NOTIFICATION_EMAIL||SMTP_USER,
      subject:"ADMIN CANCELLED ORDER · #"+order.orderNumber+" · TANMAYI STORE AND GIFTS",
      text,
      html:"<div style=\"font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#222\"><h2 style=\"background:#171717;color:#d9b45b;padding:20px\">TANMAYI STORE AND GIFTS</h2><h3>ORDER CANCELLED BY ADMIN</h3><p><b>Order:</b> #"+emailEscape(order.orderNumber)+"<br><b>Customer:</b> "+emailEscape(order.customerName||"Customer")+"<br><b>Mobile:</b> "+emailEscape(order.mobile||"")+"<br><b>Payment method:</b> "+emailEscape(method)+"<br><b>Payment status:</b> "+emailEscape(order.paymentStatus||"pending")+"<br><b>Payment UTR:</b> "+emailEscape(order.paymentUtr||"Not supplied")+"<br><b>Admin message:</b> "+emailEscape(reason)+"<br><b>Cancellation time:</b> "+emailEscape(when)+"<br><b>Order total:</b> ₹"+Number(order.total||0).toLocaleString("en-IN")+"</p><h4>Products</h4><pre>"+emailEscape(items||"Product details unavailable.")+"</pre></div>"
    });
    return {sent:true,messageId:info.messageId||""};
  } finally { transporter.close(); }
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
function orderProductsForDisplay(products) {
  const latestUpload = Math.max(0, ...products.map(p => Number(p.createdAtMillis) || 0));
  const newArrivalWindow = latestUpload - 24 * 60 * 60 * 1000;
  return products
    .map(p => ({ ...p, isNew: latestUpload > 0 && Number(p.createdAtMillis) >= newArrivalWindow }))
    .sort((a, b) =>
      Number(b.isNew) - Number(a.isNew) ||
      (a.isNew ? Number(b.createdAtMillis) - Number(a.createdAtMillis) :
        Number(a.offerPrice) - Number(b.offerPrice) || Number(b.createdAtMillis) - Number(a.createdAtMillis))
    )
    .map(({ createdAtMillis, ...p }) => p);
}
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
    // Read redemption records once and filter in memory. This avoids a Firestore
    // status-field query/index failure from blocking every customer's login.
    const redemptionSnap=await customerRef(req.user.uid).collection("redemptions").get();
    const redemptionDocs=redemptionSnap.docs;
    const pendingDoc=redemptionDocs.find(x=>x.data().status==="pending")||null;
    const takenCount=redemptionDocs.filter(x=>x.data().status==="taken").length;
    const pendingRedemption=pendingDoc?(()=>{const a=pendingDoc.data();return{id:pendingDoc.id,type:a.type,approvedPoints:moneyNumber(a.approvedPoints),status:a.status,createdAt:safeDate(a.date)}})():null;
    res.json({profile:{name:d.name||"",mobile:d.mobile||"",village:d.village||""},stamps:moneyNumber(d.stamps),latestBill:latestBillIsCurrent?safeDate(latestBillData.date):null,latestBillAmount:latestBillIsCurrent?moneyNumber(latestBillData.billTotal):0,giftsRedeemed:takenCount,pendingRedemption});
  }catch(e){console.error("customer home failed:",e.message,e.stack);res.status(500).json({error:"Could not load customer account."});}
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
    const now = Date.now();
    const heldByProduct = await countHeldReservations(reservationSnap.docs, now, id => db.collection(ORDERS_COLLECTION).doc(id).get());
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
      const heldCounts = await countHeldReservations(reservations.docs, Date.now(), id => db.collection(ORDERS_COLLECTION).doc(id).get());
      const held = heldCounts.get(req.params.id) || 0;
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
// Public, read-only product catalogue. No customer login is needed to browse the shop.
app.get("/api/public/products", async (_req, res) => {
  try {
    const [snap, reservationSnap] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).where("active", "==", true).get(),
      db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get()
    ]);
    const now = Date.now();
    const heldByProduct = await countHeldReservations(reservationSnap.docs, now, id => db.collection(ORDERS_COLLECTION).doc(id).get());
    const products = orderProductsForDisplay(snap.docs.map(d => {
      const x = d.data(), stock = Number.isInteger(Number(x.stock)) ? Number(x.stock) : 0;
      const held = heldByProduct.get(d.id) || 0;
      return { id:d.id, name:String(x.name||""), size:String(x.size||""), description:String(x.description||""), originalPrice:moneyNumber(x.originalPrice), offerPrice:moneyNumber(x.offerPrice), availableStock:Math.max(0,stock-held), photoUrls:Array.isArray(x.photoData)?x.photoData.slice(0,2):(Array.isArray(x.photoUrls)?x.photoUrls.slice(0,2):[]), createdAtMillis:asMillis(x.createdAt) };
    }));
    res.set("Cache-Control", "public, max-age=20, stale-while-revalidate=40");
    res.json({ products });
  } catch (e) {
    console.error("public product catalogue", e);
    res.status(500).json({ error:"Could not load shop products." });
  }
});

app.get("/api/customer/offers", requireUser, async (_req, res) => {
  try {
    // Brief private caching avoids repeat photo downloads while keeping stock fresh.
    res.set("Cache-Control", "private, max-age=10, stale-while-revalidate=20");
    const [snap, reservationSnap] = await Promise.all([
      db.collection(PRODUCTS_COLLECTION).where("active", "==", true).get(),
      db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get()
    ]);
    const now = Date.now();
    const heldByProduct = await countHeldReservations(reservationSnap.docs, now, id => db.collection(ORDERS_COLLECTION).doc(id).get());
    const products = orderProductsForDisplay(snap.docs.map(d => {
      const x = d.data(), stock = Number.isInteger(Number(x.stock)) ? Number(x.stock) : 0;
      const held = heldByProduct.get(d.id) || 0;
      return { id:d.id, name:x.name, size:String(x.size||""), description:String(x.description||""), originalPrice:moneyNumber(x.originalPrice), offerPrice:moneyNumber(x.offerPrice), stock, availableStock:Math.max(0, stock-held), photoUrls:Array.isArray(x.photoData)?x.photoData:(Array.isArray(x.photoUrls)?x.photoUrls:[]), createdAtMillis:asMillis(x.createdAt) };
    }));
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
      const heldCounts = await countHeldReservations(existing.docs, now, id => tx.get(db.collection(ORDERS_COLLECTION).doc(id)));
      const held = heldCounts.get(productId) || 0;
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
      let reusableRejectedUtr = false;
      let previousUtrOrderId = "";
      if (utrKeyRef) {
        const utrSnap = await tx.get(utrKeyRef);
        if (utrSnap.exists) {
          const previousOrderId = String(utrSnap.data().orderId || "");
          if (!previousOrderId) throw new Error("This UTR number has already been submitted. Please contact the shop.");
          const previousOrderSnap = await tx.get(db.collection(ORDERS_COLLECTION).doc(previousOrderId));
          if (!previousOrderSnap.exists) throw new Error("This UTR number has already been submitted. Please contact the shop.");
          const previousOrder = previousOrderSnap.data();
          // A successfully refunded order must permanently keep its original payment UTR blocked.
          const previousRefundSnap = await tx.get(db.collection(ORDER_REFUNDS_COLLECTION).doc(previousOrderId));
          const wasRefunded = previousOrder.refundStatus === "success"
            || (previousRefundSnap.exists && previousRefundSnap.data().status === "success");
          const wasAdminRejected = !wasRefunded
            && previousOrder.orderStatus === "cancelled"
            && previousOrder.cancelledByAdmin === true
            && ["submitted", "rejected"].includes(previousOrder.paymentStatus)
            && String(previousOrder.paymentUtr || "") === paymentUtr;
          if (!wasAdminRejected) throw new Error(wasRefunded
            ? "This UTR belongs to an order that has already been refunded. Duplicate UTR is not allowed."
            : "This UTR number is already linked to another running or completed order. Duplicate UTR is not allowed.");
          reusableRejectedUtr = true;
          previousUtrOrderId = previousOrderId;
        }
      }
      if (!customerSnap.exists) throw new Error("Customer profile not found. Please login again.");
      const productSnaps = new Map();
      for (const [id, ref] of productRefs) productSnaps.set(id, await tx.get(ref));
      const existingByProduct = new Map();
      for (const id of quantities.keys()) {
        existingByProduct.set(id, await tx.get(db.collection(RESERVATIONS_COLLECTION).where("productId", "==", id)));
      }

      const now = Date.now();
      const heldByProduct = new Map();
      for (const [id] of quantities) {
        const counts = await countHeldReservations(existingByProduct.get(id).docs, now, orderId => tx.get(db.collection(ORDERS_COLLECTION).doc(orderId)));
        heldByProduct.set(id, counts.get(id) || 0);
      }
      for (const [id, quantity] of quantities) {
        const productSnap = productSnaps.get(id);
        if (!productSnap?.exists || productSnap.data().active !== true) throw new Error("One of your selected offers is no longer available. Please refresh the offers.");
        const product = productSnap.data();
        const stock = Number.isInteger(Number(product.stock)) ? Number(product.stock) : 0;
        const held = heldByProduct.get(id) || 0;
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
        const utrKeyData = {
          orderId:orderRef.id,
          customerUid:req.user.uid,
          createdAt:confirmedAt,
          ...(reusableRejectedUtr ? { reusedAfterAdminRejection:true, previousOrderId:previousUtrOrderId, reusedAt:confirmedAt } : {})
        };
        if (reusableRejectedUtr) tx.set(utrKeyRef, utrKeyData);
        else tx.create(utrKeyRef, utrKeyData);
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
    await cancelExpiredCodOrders();
    const snap = await db.collection(ORDERS_COLLECTION).where("customerUid", "==", req.user.uid).get();
    const [paymentDocs, refundDocs] = await Promise.all([
      Promise.all(snap.docs.map(d=>db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(d.id).get())),
      Promise.all(snap.docs.map(d=>db.collection(ORDER_REFUNDS_COLLECTION).doc(d.id).get()))
    ]);
    const paymentById=new Map(paymentDocs.filter(d=>d.exists).map(d=>[d.id,d.data()]));
    const refundById=new Map(refundDocs.filter(d=>d.exists).map(d=>[d.id,d.data()]));
    const missingPhotoProductIds=[...new Set(snap.docs.flatMap(d=>(Array.isArray(d.data().items)?d.data().items:[])
      .filter(item=>!Array.isArray(item.photoUrls)||!item.photoUrls.length)
      .map(item=>String(item.productId||"")).filter(Boolean)))];
    const photoProductDocs=await Promise.all(missingPhotoProductIds.map(id=>db.collection(PRODUCTS_COLLECTION).doc(id).get()));
    const productPhotos=new Map(photoProductDocs.filter(d=>d.exists).map(d=>{
      const p=d.data();
      return [d.id,Array.isArray(p.photoData)?p.photoData:(Array.isArray(p.photoUrls)?p.photoUrls:[])];
    }));
    const orders = snap.docs.map(d => {
      const x=d.data(),payment=paymentById.get(d.id)||{},refund=refundById.get(d.id)||{};
      const items=(Array.isArray(x.items)?x.items:[]).map(item=>({
        ...item,
        photoUrls:Array.isArray(item.photoUrls)&&item.photoUrls.length?item.photoUrls:(productPhotos.get(String(item.productId||""))||[])
      }));
      return { id:d.id, orderNumber:x.orderNumber, items, total:moneyNumber(x.total), paymentMethod:x.paymentMethod || "CASH_ON_DELIVERY", paymentStatus:x.paymentStatus || payment.status || "pending", paymentUtr:x.paymentUtr || payment.utr || "",
        paymentRejectionMessage:x.paymentRejectionMessage || payment.rejectionMessage || "",
        adminCancellationMessage:x.adminCancellationMessage || "",
        cancelledByAdmin:Boolean(x.cancelledByAdmin),
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
      if (order.orderStatus === "processing" || order.processingStartedAt) throw new Error("Your order is already being processed / packed and can no longer be cancelled. Please contact the shop.");
      if (order.orderStatus === "completed" || order.collectionStatus === "collected") throw new Error("This order can no longer be cancelled online. Please contact the shop.");
      const online=order.paymentMethod === "ONLINE_PAYMENT";
      if(!online && order.paymentMethod === "CASH_ON_DELIVERY") codCancellationPayload={...order, id:orderId};
      let holderName="",upiId="";
      if(online){
        holderName=String(req.body?.holderName||"").trim().slice(0,100);
        upiId=String(req.body?.upiId||"").trim().slice(0,100);
        if(!holderName||!upiId) throw new Error("Enter bank account holder name and UPI ID / number to request a refund.");
        if(order.paymentStatus !== "received") throw new Error("Refund is available only after the shop has verified and received your online payment.");
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
    let completedRefund=null, completedOrder=null, sendSuccessEmail=false;
    await db.runTransaction(async tx=>{
      const [orderSnap,refundSnap]=await Promise.all([tx.get(orderRef),tx.get(refundRef)]);
      if(!orderSnap.exists) throw new Error("Order not found.");
      const order=orderSnap.data();
      if(order.paymentMethod!=="ONLINE_PAYMENT" || order.orderStatus!=="cancelled") throw new Error("Refund is available only for cancelled online payment orders.");
      if(!refundSnap.exists) throw new Error("Customer refund request was not found.");
      const old=refundSnap.data();
      if(old.status==="success") throw new Error("This refund is already marked successful.");
      const savedRefund={...old,status,message,refundUtr:refundUtr||old.refundUtr||"",screenshotData:screenshotData||old.screenshotData||"",updatedAt:admin.firestore.FieldValue.serverTimestamp(),updatedBy:req.adminUid,successAt:status==="success"?admin.firestore.FieldValue.serverTimestamp():null};
      tx.set(refundRef,savedRefund,{merge:true});
      tx.update(orderRef,{refundStatus:status,refundUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
      if(status==="success"){
        completedRefund={...old,status,message,refundUtr,screenshotData,successAt:new Date().toISOString()};
        completedOrder={...order,id:req.params.id};
        sendSuccessEmail=true;
      }
    });
    let emailStatus="not_applicable";
    if(sendSuccessEmail){
      try{
        const mail=await sendRefundSuccessNotification(completedRefund,completedOrder);
        emailStatus="sent";
        await refundRef.update({successEmailStatus:"sent",successEmailMessageId:mail.messageId||"",successEmailAt:admin.firestore.FieldValue.serverTimestamp()});
      }catch(mailError){
        emailStatus="failed";
        await refundRef.update({successEmailStatus:"failed",successEmailError:String(mailError.message||"Email failed").slice(0,250),successEmailAt:admin.firestore.FieldValue.serverTimestamp()}).catch(()=>{});
      }
    }
    res.json({ok:true,status,emailStatus,message:status==="success"?(emailStatus==="sent"?"Refund marked successful. Refund proof saved and emailed to the shop admin.":"Refund marked successful and proof saved. Admin email could not be sent; check Render SMTP settings."):"Refund update saved. Your message and any issue screenshot are visible to the customer."});
  }catch(e){res.status(400).json({error:e.message||"Could not update refund details."});}
});

// Admin verifies an online payment after visually checking the UTR and screenshot.
app.post("/api/admin/orders/:id/verify-payment", requireAdmin, async (req,res)=>{
  try{
    const orderId=String(req.params.id||"").trim();
    if(!orderId) return res.status(400).json({error:"Invalid order ID."});
    const orderRef=db.collection(ORDERS_COLLECTION).doc(orderId);
    const paymentRef=db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(orderId);
    let alreadyVerified=false;
    await db.runTransaction(async tx=>{
      const [orderSnap,paymentSnap]=await Promise.all([tx.get(orderRef),tx.get(paymentRef)]);
      if(!orderSnap.exists) throw new Error("Order not found.");
      const order=orderSnap.data();
      if(order.paymentMethod!=="ONLINE_PAYMENT") throw new Error("This order is not an online payment order.");
      if(["cancelled","expired"].includes(order.orderStatus)) throw new Error("Cancelled or expired orders cannot be payment-verified.");
      if(order.paymentStatus==="received"){
        alreadyVerified=true;
        return;
      }
      if(order.paymentStatus!=="submitted") throw new Error("This order has no pending online payment submission.");
      const submittedUtr=String(order.paymentUtr||paymentSnap.data()?.utr||"");
      const submittedScreenshot=String(paymentSnap.exists?paymentSnap.data().screenshotData||"":order.paymentScreenshotData||"");
      if(!/^\d{12}$/.test(submittedUtr)) throw new Error("A valid 12-digit UTR is missing.");
      if(!submittedScreenshot) throw new Error("Customer payment screenshot is missing from the payment submission record.");
      if(paymentSnap.exists && paymentSnap.data().status==="rejected") throw new Error("This payment submission was rejected and cannot be verified.");
      const verifiedAt=admin.firestore.FieldValue.serverTimestamp();
      tx.update(orderRef,{paymentStatus:"received",paymentVerifiedAt:verifiedAt,paymentVerifiedBy:req.adminUid});
      if(paymentSnap.exists){
        tx.set(paymentRef,{status:"verified",verifiedAt,verifiedBy:req.adminUid},{merge:true});
      }
    });
    return res.json({ok:true,alreadyVerified,message:alreadyVerified?"This online payment was already verified.":"Online payment verified successfully. You can now start processing the order."});
  }catch(e){
    console.error("verify online payment:",e);
    return res.status(400).json({error:e.message||"Could not verify online payment."});
  }
});


// Admin starts packing only after online payment verification. This locks customer cancellation.
app.post("/api/admin/orders/:id/processing", requireAdmin, async (req,res)=>{
  try{
    const orderRef=db.collection(ORDERS_COLLECTION).doc(String(req.params.id||"").trim());
    let alreadyProcessing=false;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(orderRef);
      if(!snap.exists) throw new Error("Order not found.");
      const order=snap.data();
      if(order.paymentMethod!=="ONLINE_PAYMENT") throw new Error("Processing is only available for online payment orders.");
      if(!["HOME_DELIVERY","SHOP_COLLECTION"].includes(order.fulfilmentMode)) throw new Error("Order fulfilment type is invalid.");
      if(["cancelled","expired","completed"].includes(order.orderStatus)) throw new Error("This order cannot be processed.");
      if(order.paymentStatus!=="received") throw new Error("Verify the online payment before starting processing.");
      if(order.orderStatus==="processing" || order.processingStartedAt){alreadyProcessing=true;return;}
      tx.update(orderRef,{orderStatus:"processing",processingStartedAt:admin.firestore.FieldValue.serverTimestamp(),processingStartedBy:req.adminUid,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    res.json({ok:true,alreadyProcessing,message:alreadyProcessing?"Order processing was already started.":"Order processing started. Customer cancellation is now disabled."});
  }catch(e){res.status(400).json({error:e.message||"Could not start order processing."});}
});

// Admin confirms physical collection after the payment has been received.
app.post("/api/admin/orders/:id/collect", requireAdmin, async (req,res)=>{
  try{
    const orderRef=db.collection(ORDERS_COLLECTION).doc(String(req.params.id||"").trim());
    let alreadyCollected=false;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(orderRef);
      if(!snap.exists) throw new Error("Order not found.");
      const order=snap.data();
      if(["cancelled","expired"].includes(order.orderStatus)) throw new Error("Cancelled or expired orders cannot be marked collected.");
      if(order.orderStatus==="completed" || order.collectionStatus==="collected"){
        alreadyCollected=true;
        return;
      }
      if(order.paymentStatus!=="received") throw new Error("Confirm payment before marking this order collected.");
      if(order.paymentMethod==="ONLINE_PAYMENT" && order.orderStatus!=="processing") throw new Error("Start order processing before marking this order collected or delivered.");
      tx.update(orderRef,{
        orderStatus:"collected",
        collectionStatus:"collected",
        collectedAt:admin.firestore.FieldValue.serverTimestamp(),
        collectedBy:req.adminUid,
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ok:true,alreadyCollected,message:alreadyCollected?"This order was already marked collected.":"Order marked as collected. You can now give final approval."});
  }catch(e){
    res.status(400).json({error:e.message||"Could not mark order collected."});
  }
});

// Admin confirms COD cash receipt. Online payments must use the separate verification step.
app.post("/api/admin/orders/:id/payment", requireAdmin, async (req,res)=>{
  try{
    const orderRef=db.collection(ORDERS_COLLECTION).doc(String(req.params.id||"").trim());
    let alreadyReceived=false;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(orderRef);
      if(!snap.exists) throw new Error("Order not found.");
      const order=snap.data();
      if(order.paymentMethod!=="CASH_ON_DELIVERY") throw new Error("Cash received confirmation is only for Cash on Delivery orders.");
      if(["cancelled","expired"].includes(order.orderStatus)) throw new Error("Cancelled or expired orders cannot receive payment.");
      if(order.paymentStatus==="received"){
        alreadyReceived=true;
        return;
      }
      if(order.orderStatus==="completed") throw new Error("This order is already completed.");
      tx.update(orderRef,{
        paymentStatus:"received",
        paymentReceivedAt:admin.firestore.FieldValue.serverTimestamp(),
        paymentReceivedBy:req.adminUid,
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.json({ok:true,alreadyReceived,message:alreadyReceived?"Cash payment was already recorded.":"Cash payment received. You can now mark the order collected."});
  }catch(e){
    res.status(400).json({error:e.message||"Could not record cash payment."});
  }
});

// Final admin approval: atomically complete the order and add its bill/stamps exactly once.
app.post("/api/admin/orders/:id/complete", requireAdmin, async (req,res)=>{
  try{
    const orderId=String(req.params.id||"").trim();
    if(!orderId) throw new Error("Invalid order ID.");
    const orderRef=db.collection(ORDERS_COLLECTION).doc(orderId);
    let alreadyCompleted=false, stampsAdded=0, billAmount=0, completedOrderForEmail=null;
    await db.runTransaction(async tx=>{
      const orderSnap=await tx.get(orderRef);
      if(!orderSnap.exists) throw new Error("Order not found.");
      const order=orderSnap.data();
      const reservationSnap = await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId", "==", orderId));
      if(order.orderStatus==="completed" || order.stampsStatus==="added"){
        reservationSnap.docs.filter(d => d.data().status === "active").forEach(d => tx.update(d.ref, {
          status:"collected",
          collectedAt:admin.firestore.FieldValue.serverTimestamp(),
          collectedBy:req.adminUid
        }));
        alreadyCompleted=true;
        return;
      }
      if(["cancelled","expired"].includes(order.orderStatus)) throw new Error("Cancelled or expired orders cannot be completed.");
      if(order.collectionStatus!=="collected") throw new Error("Mark the products as collected before final approval.");
      if(order.paymentStatus!=="received") throw new Error("Payment must be received before final approval.");
      const uid=String(order.customerUid||"");
      if(!uid) throw new Error("Customer account is missing for this order.");
      billAmount=moneyNumber(order.total);
      if(!(billAmount>0)) throw new Error("Order total is invalid; bill and stamps were not updated.");
      const customerDoc=customerRef(uid);
      const customerSnap=await tx.get(customerDoc);
      if(!customerSnap.exists) throw new Error("Customer account not found; bill and stamps were not updated.");
      const customer=customerSnap.data();
      const billRef=customerDoc.collection("bills").doc("order_"+orderId);
      const billSnap=await tx.get(billRef);
      if(billSnap.exists) throw new Error("A bill already exists for this order. Please contact support before retrying.");

      // Deduct purchased quantities from physical stock in the same transaction
      // that marks this order completed. The completed-order guard above makes
      // this operation idempotent and prevents a second deduction on retries.
      const orderItems=Array.isArray(order.items)?order.items:[];
      if(!orderItems.length) throw new Error("Order has no product items; stock was not changed.");
      const quantityByProduct=new Map();
      for(const item of orderItems){
        const productId=String(item.productId||"").trim();
        const quantity=Number(item.quantity);
        if(!productId||!Number.isInteger(quantity)||quantity<=0) throw new Error("A product or quantity is invalid in this order; stock was not changed.");
        quantityByProduct.set(productId,(quantityByProduct.get(productId)||0)+quantity);
      }
      const productStockUpdates=[];
      for(const [productId,quantity] of quantityByProduct){
        const productRef=db.collection(PRODUCTS_COLLECTION).doc(productId);
        const productSnap=await tx.get(productRef);
        if(!productSnap.exists) throw new Error("A product in this order no longer exists; stock was not changed.");
        const currentStock=Number(productSnap.data().stock);
        if(!Number.isInteger(currentStock)||currentStock<quantity) throw new Error("Insufficient physical stock for "+(productSnap.data().name||"a product in this order")+". Stock was not changed.");
        productStockUpdates.push({ref:productRef,newStock:currentStock-quantity});
      }
      stampsAdded=billAmount<=800?1:2;
      const oldCycle=moneyNumber(customer.cycleBillTotal ?? customer.billTotal);
      const oldLifetime=moneyNumber(customer.lifetimeBillTotal ?? customer.billTotal);
      tx.create(billRef,{
        billTotal:billAmount,
        stampsAdded,
        date:admin.firestore.FieldValue.serverTimestamp(),
        enteredBy:req.adminUid,
        source:"customer_order",
        orderId,
        orderNumber:order.orderNumber||""
      });
      tx.update(customerDoc,{
        stamps:moneyNumber(customer.stamps)+stampsAdded,
        billTotal:oldCycle+billAmount,
        cycleBillTotal:oldCycle+billAmount,
        lifetimeBillTotal:oldLifetime+billAmount
      });
      productStockUpdates.forEach(x=>tx.update(x.ref,{
        stock:x.newStock,
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      }));
      reservationSnap.docs.filter(d => d.data().status === "active").forEach(d => tx.update(d.ref, {
        status:"collected",
        collectedAt:admin.firestore.FieldValue.serverTimestamp(),
        collectedBy:req.adminUid
      }));
      tx.update(orderRef,{
        orderStatus:"completed",
        collectionStatus:"collected",
        completedAt:admin.firestore.FieldValue.serverTimestamp(),
        completedBy:req.adminUid,
        stampsStatus:"added",
        stampsAdded,
        billAmount,
        completionEmailStatus:"pending",
        updatedAt:admin.firestore.FieldValue.serverTimestamp()
      });
    });
    let completionEmailSent=false;
    if(!alreadyCompleted){
      try{
        const completedSnap=await orderRef.get();
        if(!completedSnap.exists)throw new Error("Completed order could not be reloaded for email.");
        const completedOrder={id:orderId,...completedSnap.data()};
        const mail=await sendAdminOrderCompletedNotification(completedOrder);
        completionEmailSent=mail.sent;
        await orderRef.update({
          completionEmailStatus:"sent",
          completionEmailMessageId:mail.messageId||"",
          completionEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()
        });
      }catch(mailError){
        console.error("completed order admin email failed:",mailError);
        await orderRef.update({
          completionEmailStatus:"failed",
          completionEmailError:String(mailError.message||"Email failed").slice(0,250),
          completionEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()
        }).catch(()=>{});
      }
    }
    res.json({
      ok:true,
      alreadyCompleted,
      completionEmailSent,
      stampsAdded:alreadyCompleted?0:stampsAdded,
      billAmount:alreadyCompleted?0:billAmount,
      message:alreadyCompleted?"This order is already completed; no duplicate bill or stamps were added.":(completionEmailSent?"Order completed. Customer bill and stamps were updated; completion email sent to admin.":"Order completed and customer bill/stamps updated, but admin email failed. Check Render SMTP settings.")
    });
  }catch(e){
    console.error("complete customer order:",e);
    res.status(400).json({error:e.message||"Could not complete this order."});
  }
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

// Admin can cancel an uncollected COD or online-payment order and explain the reason to the customer.
app.post("/api/admin/orders/:id/cancel", requireAdmin, async (req,res)=>{
  try{
    const orderId=String(req.params.id||"");
    const message=String(req.body?.message||"").trim().slice(0,500);
    if(!message) return res.status(400).json({error:"Enter a cancellation message for the customer."});
    const orderRef=db.collection(ORDERS_COLLECTION).doc(orderId);
    let cancelledOrder=null;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(orderRef);
      if(!snap.exists)throw new Error("Order not found.");
      const order=snap.data();
      if(!["CASH_ON_DELIVERY","ONLINE_PAYMENT"].includes(order.paymentMethod))throw new Error("Unsupported payment method.");
      if(["completed","cancelled","expired"].includes(order.orderStatus)||order.collectionStatus==="collected")throw new Error("This order can no longer be cancelled.");
      const reservations=await tx.get(db.collection(RESERVATIONS_COLLECTION).where("orderId","==",orderId));
      const paymentRef=db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(orderId);
      const paymentSnap=order.paymentMethod==="ONLINE_PAYMENT"?await tx.get(paymentRef):null;
      reservations.docs.filter(d=>d.data().status==="active").forEach(d=>tx.update(d.ref,{status:"cancelled",cancelledAt:admin.firestore.FieldValue.serverTimestamp(),cancelReason:"admin_cancelled"}));
      tx.update(orderRef,{
        orderStatus:"cancelled",
        cancelledAt:admin.firestore.FieldValue.serverTimestamp(),
        customerCancelled:false,
        cancelledByAdmin:true,
        cancelReason:"admin_cancelled",
        adminCancellationMessage:message,
        adminCancelledAt:admin.firestore.FieldValue.serverTimestamp(),
        adminCancelledBy:req.adminUid,
        ...(order.paymentMethod==="ONLINE_PAYMENT"?{paymentRejectionMessage:message,...(order.paymentStatus==="submitted"?{paymentStatus:"rejected"}:{})}: {})
      });
      if(paymentSnap?.exists && paymentSnap.data().status==="submitted"){
        tx.update(paymentRef,{status:"rejected",rejectionMessage:message,rejectedAt:admin.firestore.FieldValue.serverTimestamp(),rejectedBy:req.adminUid});
      }
      cancelledOrder={...order,id:orderId};
    });
    if(!cancelledOrder)return res.json({ok:true,message:"Order was already cancelled."});
    let cancellationEmailSent=false;
    try{
      const mail=await sendAdminOrderCancellationNotification(cancelledOrder,message);
      cancellationEmailSent=mail.sent;
      await orderRef.update({adminCancellationEmailStatus:"sent",adminCancellationEmailMessageId:mail.messageId||"",adminCancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()});
    }catch(mailError){
      console.error("admin order cancellation email failed:",mailError);
      await orderRef.update({adminCancellationEmailStatus:"failed",adminCancellationEmailError:String(mailError.message||"Email failed").slice(0,250),adminCancellationEmailUpdatedAt:admin.firestore.FieldValue.serverTimestamp()}).catch(()=>{});
    }
    res.json({ok:true,emailSent:cancellationEmailSent,message:cancellationEmailSent?"Order cancelled. Customer message saved and admin email sent.":"Order cancelled and customer message saved, but admin email failed. Check Render SMTP settings."});
  }catch(e){res.status(400).json({error:e.message||"Could not cancel order."});}
});

// Admin dashboard order API. Response fields match the Admin HTML dashboard.
app.get("/api/admin/offer-orders", requireAdmin, async (req, res) => {
  try {
    const scope = ["history","completed"].includes(req.query.scope) ? req.query.scope : "active";
    // Expired COD orders are handled by the background timer below, not during dashboard requests.

    const orderCollection = db.collection(ORDERS_COLLECTION);
    let rawOrders = [];
    let todayCustomers = [];
    let stats = {};

    let completedTotal = null, completedHasMore = false, completedNextOffset = 0;
    if (scope === "completed") {
      // Page completed orders so the admin history response stays small and fast,
      // even when orders contain large product-image data URLs.
      const snap = await orderCollection.where("orderStatus", "==", "completed").get();
      const sorted = snap.docs.map(d => ({ id:d.id, data:d.data() }))
        .sort((a,b) => {
          const av = a.data.completedAt?.toMillis?.() || a.data.confirmedAt?.toMillis?.() || a.data.createdAt?.toMillis?.() || 0;
          const bv = b.data.completedAt?.toMillis?.() || b.data.confirmedAt?.toMillis?.() || b.data.createdAt?.toMillis?.() || 0;
          return bv-av;
        });
      const offset = Math.max(0, Math.min(1000000, Number.parseInt(req.query.offset || "0",10) || 0));
      const pageSize = 20;
      completedTotal = sorted.length;
      rawOrders = sorted.slice(offset, offset+pageSize);
      completedHasMore = offset+pageSize < sorted.length;
      completedNextOffset = offset+rawOrders.length;
    } else if (scope === "history") {
      // Cancelled/expired history is fetched separately from completed orders.
      const snap = await orderCollection.where("orderStatus", "in", ["cancelled", "expired"]).get();
      rawOrders = snap.docs.map(d => ({ id:d.id, data:d.data() }));
    } else {
      // Dashboard refresh reads only orders that still need attention, plus refunds in progress.
      const [activeSnap, refundOrdersSnap, todaySnap, readyCountSnap, oldCountSnap, completedCountSnap] = await Promise.all([
        orderCollection.where("orderStatus", "in", ["ready", "collected"]).get(),
        orderCollection.where("refundStatus", "in", ["requested", "success"]).get(),
        (() => {
          const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
          const todayStart = new Date(todayKey + "T00:00:00+05:30");
          const tomorrow = new Date(todayStart.getTime() + 86400000);
          return orderCollection
            .where("confirmedAt", ">=", admin.firestore.Timestamp.fromDate(todayStart))
            .where("confirmedAt", "<", admin.firestore.Timestamp.fromDate(tomorrow)).get();
        })(),
        orderCollection.where("orderStatus", "==", "ready").count().get(),
        orderCollection.where("orderStatus", "in", ["cancelled", "expired"]).count().get(),
        orderCollection.where("orderStatus", "==", "completed").count().get()
      ]);
      const byId = new Map();
      activeSnap.docs.forEach(d => byId.set(d.id, { id:d.id, data:d.data() }));
      refundOrdersSnap.docs.forEach(d => {
        const x = d.data();
        if (x.paymentMethod === "ONLINE_PAYMENT" && x.orderStatus === "cancelled") {
          byId.set(d.id, { id:d.id, data:x });
        }
      });
      rawOrders = [...byId.values()];

      const today = todaySnap.docs.map(d => ({ id:d.id, ...d.data(), orderStatus:d.data().orderStatus || "ready" }));
      const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
      const todayCustomersMap = new Map();
      for (const x of today) {
        const key = x.customerUid || x.mobile || x.customerName;
        const current = todayCustomersMap.get(key) || { name:x.customerName || "Customer", mobile:x.mobile || "", count:0 };
        current.count += 1;
        todayCustomersMap.set(key, current);
      }
      todayCustomers = [...todayCustomersMap.values()];
      stats = {
        newOrders:readyCountSnap.data().count || 0,
        oldOrders:oldCountSnap.data().count || 0,
        completedOrders:completedCountSnap.data().count || 0,
        todayOrders:today.length,
        pendingToday:today.filter(x => !["completed", "cancelled", "expired"].includes(x.orderStatus)).length,
        completedToday:today.filter(x => x.orderStatus === "completed").length
      };
    }

    // Fetch payment/refund documents only for the orders included in this response.
    const paymentIds = [...new Set(rawOrders
      .filter(({data}) => data.paymentMethod === "ONLINE_PAYMENT")
      .map(({id}) => id))];
    const refundIds = [...new Set(rawOrders
      .filter(({data}) => Boolean(data.refundStatus))
      .map(({id}) => id))];
    const [paymentDocs, refundDocs] = await Promise.all([
      Promise.all(paymentIds.map(id => db.collection(PAYMENT_SUBMISSIONS_COLLECTION).doc(id).get())),
      Promise.all(refundIds.map(id => db.collection(ORDER_REFUNDS_COLLECTION).doc(id).get()))
    ]);
    const paymentByOrder = new Map(paymentDocs.filter(d => d.exists).map(d => [d.id, d.data()]));
    const refundByOrder = new Map(refundDocs.filter(d => d.exists).map(d => [d.id, d.data()]));

    // Keep the legacy-photo fallback limited to the orders being displayed.
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

    const orders = rawOrders.map(({id, data:x}) => {
      const confirmedAt = safeDate(x.confirmedAt || x.createdAt);
      const items = (Array.isArray(x.items) ? x.items : []).map(item => ({
        ...item,
        photoUrls:Array.isArray(item.photoUrls) && item.photoUrls.length
          ? item.photoUrls
          : (productPhotos.get(String(item.productId || "")) || [])
      }));
      const payment = paymentByOrder.get(id) || {};
      const refund = refundByOrder.get(id) || null;
      return {
        id, ...x, confirmedAt, expiresAt:asMillis(x.expiresAt),
        orderStatus:x.orderStatus || "ready", total:moneyNumber(x.total), items,
        paymentUtr:x.paymentUtr || payment.utr || "",
        paymentScreenshotData:(x.orderStatus === "cancelled" || payment.status === "submitted" || refund) ? (payment.screenshotData || "") : "",
        adminCancellationMessage:x.adminCancellationMessage || "",
        cancelledByAdmin:Boolean(x.cancelledByAdmin),
        paymentSubmissionStatus:payment.status || "",
        refund,
        customerName:x.customerName || "Customer", mobile:x.mobile || ""
      };
    }).sort((a,b) => new Date(b.confirmedAt || 0) - new Date(a.confirmedAt || 0));

    const runningOrders = orders.filter(x => !["completed", "cancelled", "expired"].includes(x.orderStatus));
    const completedOrdersList = orders.filter(x => x.orderStatus === "completed");
    const cancelledOrders = orders.filter(x => ["cancelled", "expired"].includes(x.orderStatus)).slice(0, 2);
    res.json({
      scope, orders, runningOrders, completedOrdersList, cancelledOrders,
      todayCustomers, stats,
      ...(scope === "completed" ? {totalCount:completedTotal,hasMore:completedHasMore,nextOffset:completedNextOffset} : {})
    });
  } catch(e) {
    console.error("admin offer orders",e);
    res.status(500).json({error:"Could not load customer orders."});
  }
});

// Admin view: confirmed reservations waiting for the customer to collect in-store.
app.get("/api/admin/offer-reservations", requireAdmin, async (_req, res) => {
  try {
    const snap = await db.collection(RESERVATIONS_COLLECTION).where("status", "==", "active").get();
    const now = Date.now();
    const heldCounts = await countHeldReservations(snap.docs, now, id => db.collection(ORDERS_COLLECTION).doc(id).get());
    const live = snap.docs.filter(d => (heldCounts.get(d.data().productId) || 0) > 0 && (d.data().orderId || asMillis(d.data().expiresAt) > now));
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
    const snap=await db.collection(ORDERS_COLLECTION).where("orderStatus","==","ready").get();
    const now=Date.now();
    for(const doc of snap.docs){
      const order=doc.data();
      if(order.orderStatus!=="ready"||order.collectionStatus==="collected")continue;
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

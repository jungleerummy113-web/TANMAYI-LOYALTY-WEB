
import{initializeApp}from'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import{getAuth,signInWithEmailAndPassword,createUserWithEmailAndPassword,onAuthStateChanged,signOut,updatePassword,reauthenticateWithCredential,EmailAuthProvider,}from'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import{getFirestore,doc,getDoc}from'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
const cfg={apiKey:'AIzaSyBXnsV3rJ7VR74EIbyCjhQ1gfGxIxD21kU',authDomain:'tanmayi-store-and-gifts.firebaseapp.com',projectId:'tanmayi-store-and-gifts',storageBucket:'tanmayi-store-and-gifts.firebasestorage.app',messagingSenderId:'1061146758363',appId:'1:1061146758363:web:3260ea51094ba5fbab10fe',measurementId:'G-3RWVE6G0W9'};
const app=initializeApp(cfg),auth=getAuth(app),db=getFirestore(app),API='https://tanmayi-pin-reset-api.onrender.com';
// Firebase Auth's default browser persistence restores the saved session asynchronously.
// Do not block module startup; onAuthStateChanged below selects the page after restoration.
window.tanmayiAuth=auth;window.tanmayiFirebaseAuth={EmailAuthProvider,reauthenticateWithCredential,updatePassword};
const $=id=>document.getElementById(id),money=n=>'₹'+Number(n||0).toLocaleString('en-IN'),date=v=>v?new Date(v).toLocaleString('en-IN'):'—',customerEmail=m=>`${m}@tanmayi-loyalty.app`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let customers=[],selected=null,pendingId=null,pendingOfferCart=[],pendingOrderRequestId=null,customerProfile=null,customerOrdersCache=[],customerProductsCache=[],customerPaymentQr="",paymentStepOpen=false,orderConfirmedData=null,selectedOrderPaymentMethod="CASH_ON_DELIVERY",selectedFulfilmentMode="SHOP_COLLECTION",deliveryCoordinates=null,activeOfferAnchorId="",cartOwnerMobile="",cartRestoredForMobile="",pendingOfferCartExpiresAt=0;
const CUSTOMER_CART_TTL_MS=30*60*1000;
function customerCartExpiryKey(mobile){return customerCartStorageKey(mobile)+"_expires_at"}
function clearExpiredCustomerCart(){
  if(!pendingOfferCart.length||!pendingOfferCartExpiresAt||Date.now()<pendingOfferCartExpiresAt)return false;
  pendingOfferCart=[];pendingOfferCartExpiresAt=0;pendingOrderRequestId=null;paymentStepOpen=false;selectedOrderPaymentMethod="CASH_ON_DELIVERY";
  if(cartOwnerMobile){try{localStorage.removeItem(customerCartStorageKey(cartOwnerMobile));localStorage.removeItem(customerCartExpiryKey(cartOwnerMobile))}catch(_){}}
  renderFloatingCart();renderInlineProductSelections();closeOrderFlow();
  const mount=$('orderFlowMount');if(mount)mount.style.display='none';
  if($('customerReservations'))$('customerReservations').innerHTML='<p class="muted">Your cart selection expired after 30 minutes. Please add the products again.</p>';
  return true;
}
function startCustomerCartExpiry(){if(!pendingOfferCart.length)pendingOfferCartExpiresAt=Date.now()+CUSTOMER_CART_TTL_MS}
setInterval(()=>{if(clearExpiredCustomerCart())loadCustomerProducts().catch(()=>{})},15000);
function customerCartStorageKey(mobile){return 'tanmayi_customer_cart_v1_'+String(mobile||'').replace(/\D/g,'')}
function savePendingOfferCart(){
  if(!pendingOfferCart.length)pendingOfferCartExpiresAt=0;
  if(cartOwnerMobile){try{
    if(pendingOfferCart.length){
      localStorage.setItem(customerCartStorageKey(cartOwnerMobile),JSON.stringify(pendingOfferCart));
      if(pendingOfferCartExpiresAt)localStorage.setItem(customerCartExpiryKey(cartOwnerMobile),String(pendingOfferCartExpiresAt));
    }else{
      localStorage.removeItem(customerCartStorageKey(cartOwnerMobile));
      localStorage.removeItem(customerCartExpiryKey(cartOwnerMobile));
    }
  }catch(_){}}
  renderFloatingCart();
}
function restorePendingOfferCart(mobile){
  const key=String(mobile||'').replace(/\D/g,'');if(!key||cartRestoredForMobile===key)return;
  cartOwnerMobile=key;cartRestoredForMobile=key;
  try{
    const saved=JSON.parse(localStorage.getItem(customerCartStorageKey(key))||'[]');
    const customerCart=Array.isArray(saved)?saved.filter(x=>x&&x.productId).map(x=>({...x,quantity:Math.max(1,Number(x.quantity)||1),offerPrice:Number(x.offerPrice)||0,photoUrls:Array.isArray(x.photoUrls)?x.photoUrls:[]})):[];
    let guestCart=[];try{guestCart=JSON.parse(sessionStorage.getItem('tanmayi_guest_order_cart_v1')||'[]')}catch(_){}
    const merged=new Map(customerCart.map(x=>[x.productId,x]));
    if(Array.isArray(guestCart))guestCart.filter(x=>x&&x.productId).forEach(x=>{
      const existing=merged.get(x.productId);
      if(existing)existing.quantity=Math.max(1,Number(existing.quantity)||1)+Math.max(1,Number(x.quantity)||1);
      else merged.set(x.productId,{productId:x.productId,productName:String(x.productName||'Product'),offerPrice:Number(x.offerPrice)||0,quantity:Math.max(1,Number(x.quantity)||1),photoUrls:[]});
    });
    pendingOfferCart=[...merged.values()];
    pendingOfferCartExpiresAt=Number(localStorage.getItem(customerCartExpiryKey(key))||0);
    if(guestCart.length&&!pendingOfferCartExpiresAt)pendingOfferCartExpiresAt=Date.now()+CUSTOMER_CART_TTL_MS;
    sessionStorage.removeItem('tanmayi_guest_order_cart_v1');
    if(clearExpiredCustomerCart())return;
    if(pendingOfferCart.length&&!pendingOfferCartExpiresAt)pendingOfferCartExpiresAt=Date.now()+CUSTOMER_CART_TTL_MS;
    savePendingOfferCart();
  }catch(_){pendingOfferCart=[];pendingOfferCartExpiresAt=0}
  renderFloatingCart();
}
function renderFloatingCart(){const button=$('floatingCartButton'),badge=$('floatingCartBadge'),list=$('floatingCartItems'),totalEl=$('floatingCartTotal'),checkout=$('floatingCartCheckout');if(!button||!badge||!list)return;const count=pendingOfferCart.reduce((n,x)=>n+Math.max(1,Number(x.quantity)||1),0),total=pendingOfferCart.reduce((n,x)=>n+Number(x.offerPrice||0)*Math.max(1,Number(x.quantity)||1),0);badge.textContent=String(count);button.style.display=cartOwnerMobile?'flex':'none';list.innerHTML=pendingOfferCart.length?pendingOfferCart.map(x=>{const p=customerProductsCache.find(v=>v.id===x.productId),photo=p?.photoUrls?.[0]||x.photoUrls?.[0]||'';return '<div class="floating-cart-line">'+(photo?'<img src="'+esc(photo)+'" alt="">':'<div style="width:66px;height:66px;border-radius:10px;background:#eee;display:grid;place-items:center">🛍️</div>')+'<div class="floating-cart-line-info"><strong>'+esc(p?.name||x.productName)+'</strong><div>'+moneyPrice(p?.offerPrice??x.offerPrice)+' × '+Math.max(1,Number(x.quantity)||1)+'</div><b>'+moneyPrice(Number(p?.offerPrice??x.offerPrice)*Math.max(1,Number(x.quantity)||1))+'</b></div><button type="button" class="floating-cart-remove" data-floating-cart-remove="'+esc(x.productId)+'">Remove</button></div>'}).join(''):'<p class="muted">Your cart is empty. Select a product to add it here.</p>';if(totalEl)totalEl.textContent=pendingOfferCart.length?'Cart total: '+moneyPrice(total):'';if(checkout)checkout.disabled=!pendingOfferCart.length}
$('floatingCartButton')?.addEventListener('click',()=>{renderFloatingCart();$('floatingCartBackdrop').classList.remove('hidden');$('floatingCartBackdrop').setAttribute('aria-hidden','false')});
$('floatingCartClose')?.addEventListener('click',()=>{$('floatingCartBackdrop').classList.add('hidden');$('floatingCartBackdrop').setAttribute('aria-hidden','true')});
$('floatingCartBackdrop')?.addEventListener('click',e=>{if(e.target.id==='floatingCartBackdrop'){$('floatingCartBackdrop').classList.add('hidden');$('floatingCartBackdrop').setAttribute('aria-hidden','true')}});
$('floatingCartItems')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-floating-cart-remove]');
  if(!b)return;
  const removedId=b.dataset.floatingCartRemove;
  pendingOfferCart=pendingOfferCart.filter(x=>x.productId!==removedId);
  savePendingOfferCart();
  // Update only the affected product/cart UI; do not reload the catalogue.
  renderInlineProductSelections();
  if(pendingOfferCart.length){
    renderReservations([]);
  }else{
    paymentStepOpen=false;
    selectedOrderPaymentMethod='CASH_ON_DELIVERY';
    closeOrderFlow();
    const mount=$('orderFlowMount');
    if(mount)mount.style.display='none';
  }
  renderFloatingCart();
});
$('floatingCartCheckout')?.addEventListener('click',()=>{
  if(!pendingOfferCart.length)return;
  const checkoutButton=$('floatingCartCheckout');
  checkoutButton.disabled=true;
  $('floatingCartBackdrop')?.classList.add('hidden');
  $('floatingCartBackdrop')?.setAttribute('aria-hidden','true');
  activeOfferAnchorId=pendingOfferCart[pendingOfferCart.length-1].productId;
  paymentStepOpen=true;
  selectedFulfilmentMode='SHOP_COLLECTION';
  selectedOrderPaymentMethod='CASH_ON_DELIVERY';
  const placed=placeOrderFlowAfterProduct(activeOfferAnchorId);
  if(!placed){
    checkoutButton.disabled=false;
    alert('Could not open checkout under the selected product. Please refresh and try again.');
    return;
  }
  // Render the existing delivery and payment controls inside the selected product's checkout area.
  renderReservations([]);
  requestAnimationFrame(()=>{
    const flow=$('orderFlowBackdrop');
    flow?.scrollIntoView({behavior:'smooth',block:'nearest'});
  });
  checkoutButton.disabled=!pendingOfferCart.length;
  // Refresh the configured QR in the background; do not change payment methods or validation.
  api('/api/customer/payment-settings').then(settings=>{
    if(settings&&settings.qrData){
      customerPaymentQr=settings.qrData;
      if(paymentStepOpen&&$('orderFlowBackdrop')&&!$('orderFlowBackdrop').classList.contains('hidden'))renderReservations([]);
    }
  }).catch(error=>console.warn('Customer payment QR refresh failed:',error.message));
});
function msg(id,t){$(id).textContent=t;$(id).classList.remove('hidden')}function clear(id){$(id).classList.add('hidden');$(id).textContent=''}
function show(id){
  ['adminLogin','customerLogin','customerView','adminApp'].forEach(x=>$(x).classList.toggle('hidden',x!==id));
  const publicStore=$('publicStorefront');
  if(publicStore)publicStore.classList.toggle('hidden',id==='adminLogin'||id==='adminApp'||id==='customerView');
  // During guest checkout, keep the public catalogue visible behind the login/register form.
  if(id==='customerLogin'&&!adminRoute)publicStore?.classList.remove('hidden');
  const guestLogin=$('guestCustomerLoginPrompt');
  if(guestLogin)guestLogin.classList.toggle('hidden',id!=='publicStorefront'||!!auth.currentUser||adminRoute);
}
let apiAuthUser=null;
async function api(path,method='GET',body=null){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);try{let user=auth.currentUser||apiAuthUser;if(!user){await auth.authStateReady();user=auth.currentUser||apiAuthUser;}if(!user)throw Error('Please login to continue.');const token=await Promise.race([user.getIdToken(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Secure connection is taking longer than expected. Please wait and retry.')),15000))]);if(!token)throw Error('Secure connection is not ready yet. Please wait and retry.');const r=await fetch(API+path,{method,signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json().catch(()=>({error:'Unexpected server response'}));if(!r.ok)throw Error(d.error||'Request failed');return d}catch(e){if(e.name==='AbortError')throw Error('Server response timeout. Please check your internet and try again.');throw e}finally{clearTimeout(timer)}}
async function pinApi(path,body,token=''){const r=await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});const d=await r.json().catch(()=>({error:'Unexpected response'}));if(!r.ok)throw Error(d.error||'PIN reset failed');return d}

let publicProductsCache=[],guestOrderCart=[],guestCheckoutStarted=false;
function readGuestOrderCart(){
  // A guest cart is valid only during the current page visit.
  // Clear any tab-restored/stale cart when the storefront is freshly initialized.
  try{sessionStorage.removeItem('tanmayi_guest_order_cart_v1')}catch(_){}
  guestOrderCart=[];
  guestCheckoutStarted=false;
}
function saveGuestOrderCart(){
  // Keep the cart only in this active tab so it can transfer to login.
  // The key is cleared by readGuestOrderCart on refresh or a restored/new visit.
  try{sessionStorage.setItem('tanmayi_guest_order_cart_v1',JSON.stringify(guestOrderCart))}catch(_){}
  renderPublicCart();
}
function renderPublicCart(){
  const panel=$('publicCartPanel'),items=$('publicCartItems'),total=$('publicCartTotal');if(!panel||!items)return;
  // The selected-product card itself is the checkout entry point; keep the old page-bottom cart hidden.
  panel.classList.add('hidden');
  items.innerHTML=guestOrderCart.map(p=>`<div class="public-cart-line"><img src="${esc((p.photoUrls||[])[0]||'')}" alt="${esc(p.productName)}"><span><b>${esc(p.productName)}</b><small>${moneyPrice(p.offerPrice)} × ${Math.max(1,Number(p.quantity)||1)}</small></span><button type="button" class="secondary" data-guest-remove="${esc(p.productId)}">Remove</button></div>`).join('');
  const amount=guestOrderCart.reduce((n,p)=>n+Number(p.offerPrice||0)*Math.max(1,Number(p.quantity)||1),0);
  if(total)total.textContent='Selected items: '+guestOrderCart.reduce((n,p)=>n+Math.max(1,Number(p.quantity)||1),0)+' · Total: '+moneyPrice(amount);
  const grid=$('publicProducts');
  if(grid)grid.querySelectorAll('[data-guest-add]').forEach(button=>{
    const card=button.closest('[data-public-product-card]');
    const selected=guestOrderCart.find(p=>p.productId===button.dataset.guestAdd);
    const area=card?.querySelector('[data-public-selected]');
    if(!area)return;
    const anotherSelectionExists=guestOrderCart.some(p=>p.productId!==button.dataset.guestAdd);
    button.disabled=anotherSelectionExists||Number((publicProductsCache.find(p=>p.id===button.dataset.guestAdd)||{}).availableStock??0)<=0;
    if(anotherSelectionExists){button.textContent='Cancel previous selection first';}
    else if(!selected){area.hidden=true;area.innerHTML='';button.textContent='Add to Order';return;}
    if(!selected)return;
    const qty=Math.max(1,Number(selected.quantity)||1);
    const photo=(selected.photoUrls||[])[0]||'';
    area.hidden=false;
    area.innerHTML='<span class="public-selected-badge">✓ ADDED TO YOUR ORDER</span><div class="public-selected-info">'+(photo?'<img src="'+esc(photo)+'" alt="'+esc(selected.productName)+' selected">':'')+'<span><b>Selected quantity: '+qty+'</b><small>'+moneyPrice(Number(selected.offerPrice)*qty)+'</small></span></div><div class="public-selected-actions"><button type="button" class="secondary public-cancel-selection" data-guest-cancel="'+esc(selected.productId)+'">Cancel selection</button><button type="button" class="gold public-inline-checkout" data-public-checkout>Continue to Order · Login / Register</button></div>';
    if(!anotherSelectionExists)button.textContent='Add One More';
  });
}
async function loadPublicProducts(){
  const mount=$('publicProducts');if(!mount)return;
  readGuestOrderCart();renderPublicCart();
  try{
    const response=await fetch(API+'/api/public/products',{method:'GET',headers:{Accept:'application/json'},cache:'default'});
    const data=await response.json().catch(()=>({error:'Shop products could not be loaded.'}));
    if(!response.ok)throw Error(data.error||'Shop products could not be loaded.');
    publicProductsCache=Array.isArray(data.products)?data.products:[];
    guestOrderCart=guestOrderCart.map(item=>{
      const latest=publicProductsCache.find(p=>p.id===item.productId);
      return latest?{...item,productName:latest.name,offerPrice:Number(latest.offerPrice)||0,photoUrls:Array.isArray(latest.photoUrls)?latest.photoUrls.slice(0,2):item.photoUrls||[]}:item;
    });
    saveGuestOrderCart();
    mount.innerHTML=publicProductsCache.map(p=>{
      const photos=Array.isArray(p.photoUrls)?p.photoUrls.slice(0,2):[];
      const available=Math.max(0,Number(p.availableStock??0));
      const inCart=guestOrderCart.find(x=>x.productId===p.id);
      return `<div class="customer-product-card product-card" data-public-product-card="${esc(p.id)}">
        <b>${esc(p.name)}</b>
        <div class="customer-product-topline">${p.isNew?'<span class="product-new-badge">NEW ARRIVAL</span>':''}${photos.length>1?'<span class="product-photo-hint">📸 2 PHOTOS · SWIPE LEFT / RIGHT <span class="photo-arrow">↔</span></span>':''}</div>
        <div class="product-photos">${photos.map((u,i)=>`<img src="${esc(u)}" alt="${esc(p.name)} photo ${i+1}" loading="lazy" decoding="async">`).join('')}</div>
        <div class="customer-product-price-row"><p class="customer-product-prices"><span class="price-old">${moneyPrice(p.originalPrice)}</span> <b class="price-offer">${moneyPrice(p.offerPrice)}</b></p></div>
        <div class="customer-product-info-row">${p.size?`<p class="stock-line"><b>Size:</b> ${esc(p.size)}</p>`: '<span></span>'}${p.description?`<details class="customer-product-description"><summary>Description</summary><p>${esc(p.description)}</p></details>`:''}</div>
        <div class="customer-product-actions-row">
        <p class="stock-line">${available>0?'Stock: '+available:'NO STOCK'}</p>
        <button type="button" data-guest-add="${esc(p.id)}" ${available<=0?'disabled':''}>${inCart?'Add One More':'Select & Add'}</button></div>
        <div class="public-inline-selection" data-public-selected hidden></div>
      </div>`;
    }).join('')||'<p class="muted">New products and offers will be displayed here soon.</p>';
    renderPublicCart();
  }catch(e){console.error('Public shop catalogue failed:',e);mount.innerHTML='<p class="muted">Products could not load right now. Please tap Refresh to try again.</p><button type="button" class="secondary" id="retryPublicProducts">Refresh Products</button>'}
}
$('publicProducts')?.addEventListener('click',event=>{
  const cancel=event.target.closest('[data-guest-cancel]');
  if(cancel){
    guestOrderCart=guestOrderCart.filter(p=>p.productId!==cancel.dataset.guestCancel);
    saveGuestOrderCart();
    return;
  }
  const checkout=event.target.closest('[data-public-checkout]');
  if(checkout){
    if(!guestOrderCart.length)return;
    guestCheckoutStarted=true;
    $('publicCartPanel')?.classList.add('hidden');
    show('customerLogin');
    requestAnimationFrame(()=> $('customerLogin')?.scrollIntoView({behavior:'smooth',block:'start'}));
    return;
  }
  const button=event.target.closest('[data-guest-add]');if(!button)return;
  const product=publicProductsCache.find(p=>p.id===button.dataset.guestAdd);if(!product)return;
  const available=Math.max(0,Number(product.availableStock??0));
  const existing=guestOrderCart.find(p=>p.productId===product.id);
  if(guestOrderCart.length&&!existing){
    alert('Please cancel your currently selected product first, then choose another product.');
    return;
  }
  if(existing){if(existing.quantity>=available){alert('Only '+available+' piece(s) are available.');return}existing.quantity++}
  else guestOrderCart.push({productId:product.id,productName:product.name,offerPrice:Number(product.offerPrice)||0,quantity:1,photoUrls:Array.isArray(product.photoUrls)?product.photoUrls.slice(0,2):[]});
  if(existing&&Array.isArray(product.photoUrls))existing.photoUrls=product.photoUrls.slice(0,2);
  saveGuestOrderCart();
});
$('publicCartItems')?.addEventListener('click',event=>{
  const button=event.target.closest('[data-guest-remove]');if(!button)return;
  guestOrderCart=guestOrderCart.filter(p=>p.productId!==button.dataset.guestRemove);saveGuestOrderCart();
  const card=$('publicProducts')?.querySelector('[data-guest-add="'+CSS.escape(button.dataset.guestRemove)+'"]');
  if(card)card.textContent='Add to Order';
});
$('guestCustomerLoginButton')?.addEventListener('click',()=>{
  if(adminRoute||auth.currentUser)return;
  show('customerLogin');
  $('publicStorefront')?.classList.add('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
});
$('publicContinueOrder')?.addEventListener('click',()=>{
  if(!guestOrderCart.length)return;
  // Keep the selected cart saved, but remove its panel from the login screen.
  guestCheckoutStarted=true;
  $('publicCartPanel')?.classList.add('hidden');
  show('customerLogin');
  requestAnimationFrame(()=> $('customerLogin')?.scrollIntoView({behavior:'smooth',block:'start'}));
});
$('publicProducts')?.addEventListener('click',event=>{
  if(event.target?.id==='retryPublicProducts')loadPublicProducts();
});
async function imageData(file){if(!file)return '';if(!file.type.startsWith('image/'))throw Error('Please select an image file.');const img=new Image(),url=URL.createObjectURL(file);try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url});let maxSide=720,scale=Math.min(1,maxSide/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);for(const quality of [0.62,0.54,0.46,0.40]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<=360000)return data}maxSide=640;scale=Math.min(1,maxSide/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',0.38);if(data.length>360000)throw Error('Photo is too large. Please choose a smaller image.');return data}finally{URL.revokeObjectURL(url)}}
function moneyPrice(v){return '₹'+Number(v||0).toLocaleString('en-IN')}
async function loadAdminProducts(){
  try{
    const r=await api('/api/admin/products');
    $('adminProducts').innerHTML=r.products.map(x=>`<div class="product-card">
      <strong>${esc(x.name)}</strong>
      <div class="product-photos">${x.photoUrls.map(u=>`<img src="${esc(u)}" alt="${esc(x.name)}" data-zoom-product-image="${esc(u)}" loading="lazy">`).join('')}</div>
      <p><span class="price-old">${moneyPrice(x.originalPrice)}</span> <span class="price-offer">${moneyPrice(x.offerPrice)}</span></p>
      ${x.size?`<p class="stock-line"><b>Size:</b> ${esc(x.size)}</p>`:''}
      ${x.description?`<p style="white-space:pre-wrap"><b>Description:</b> ${esc(x.description)}</p>`:''}
      <p class="stock-line">Total physical stock: ${Number(x.stock??0)} pieces</p>
      <p class="stock-line">Confirmed / held by customers: ${Number(x.reservedCount??0)} pieces</p>
      <button type="button" class="secondary" disabled>Available Stock: ${Math.max(0,Number(x.availableStock??x.stock??0))} pieces</button>
      <details class="product-edit">
        <summary>Edit product, photos, price &amp; stock</summary>
        <label>Product name</label><input id="edit-name-${esc(x.id)}" maxlength="80" value="${esc(x.name)}">
        <label>Original price (₹)</label><input id="edit-original-${esc(x.id)}" type="number" min="1" step="1" value="${Number(x.originalPrice)}">
        <label>Offer price (₹)</label><input id="edit-offer-${esc(x.id)}" type="number" min="1" step="1" value="${Number(x.offerPrice)}">
        <label>Product size (example: 10 × 24 inch)</label><input id="edit-size-${esc(x.id)}" maxlength="80" value="${esc(x.size||'')}" placeholder="10 × 24 inch">
        <label>Product description / details</label><textarea id="edit-description-${esc(x.id)}" rows="4" maxlength="1200" placeholder="Enter product details">${esc(x.description||'')}</textarea>
        <label>Available stock</label><input id="edit-stock-${esc(x.id)}" type="number" min="0" step="1" value="${Number(x.stock??0)}">
        <label>Replace Photo 1 (optional)</label><input id="edit-photo1-${esc(x.id)}" type="file" accept="image/*">
        <label>Replace Photo 2 (optional)</label><input id="edit-photo2-${esc(x.id)}" type="file" accept="image/*">
        <small class="muted">Choose new photos only for the angles you want to replace. Existing photos stay unchanged if left empty.</small>
        <button class="gold" data-product-save="${esc(x.id)}">Save product changes</button>
      </details>
      <button class="secondary" data-product-toggle="${esc(x.id)}" data-active="${x.active?'1':'0'}">${x.active?'Pause offer':'Activate offer'}</button>
    </div>`).join('')||'<p class="muted">No products uploaded yet.</p>';

    document.querySelectorAll('[data-product-save]').forEach(b=>b.onclick=async()=>{
      const id=b.dataset.productSave, name=$('edit-name-'+id).value.trim(),
        originalPrice=Number($('edit-original-'+id).value),offerPrice=Number($('edit-offer-'+id).value),
        size=$('edit-size-'+id).value.trim(),description=$('edit-description-'+id).value.trim(),
        stock=Number($('edit-stock-'+id).value),f1=$('edit-photo1-'+id).files[0],f2=$('edit-photo2-'+id).files[0];
      if(!name||!Number.isFinite(originalPrice)||originalPrice<=0||!Number.isFinite(offerPrice)||offerPrice<=0||offerPrice>=originalPrice||!Number.isInteger(stock)||stock<0)
        return msg('productAdminMsg','Enter a product name, valid prices and whole-number stock. Offer price must be below original price.');
      b.disabled=true;
      try{
        const body={name,originalPrice,offerPrice,stock,size,description};
        if(f1)body.photo1=await imageData(f1);
        if(f2)body.photo2=await imageData(f2);
        await api('/api/admin/products/'+encodeURIComponent(id),'PATCH',body);
        msg('productAdminMsg','Product details, photos, price and stock updated successfully.');
        await loadAdminProducts();
      }catch(e){msg('productAdminMsg',e.message)}finally{b.disabled=false}
    });

    document.querySelectorAll('[data-product-toggle]').forEach(b=>b.onclick=async()=>{
      b.disabled=true;
      try{
        await api('/api/admin/products/'+encodeURIComponent(b.dataset.productToggle),'PATCH',{active:b.dataset.active!=='1'});
        msg('productAdminMsg',b.dataset.active==='1'?'Offer paused successfully.':'Offer activated successfully.');
        await loadAdminProducts();
      }catch(e){msg('productAdminMsg',e.message)}finally{b.disabled=false}
    });
  }catch(e){msg('productAdminMsg',e.message)}
}
async function loadAdminPaymentSettings(){
  try{
    const r=await api('/api/admin/payment-settings');
    const el=$('adminPaymentQrPreview');
    if(r.qrData){el.innerHTML=`<strong>Current Customer Payment QR Code</strong><img src="${esc(r.qrData)}" alt="Shop UPI QR code" style="max-width:220px;max-height:220px;object-fit:contain;background:#fff;padding:8px;border-radius:8px">`;el.classList.remove('hidden')}
    else{el.innerHTML='<span class="muted">No payment QR uploaded yet.</span>';el.classList.remove('hidden')}
  }catch(e){msg('adminPaymentQrMsg',e.message||'Could not load payment QR settings.')}
}
$('saveAdminPaymentQr').onclick=async()=>{
  clear('adminPaymentQrMsg');
  const file=$('adminPaymentQrFile').files[0];
  if(!file)return msg('adminPaymentQrMsg','Choose a payment QR image first.');
  $('saveAdminPaymentQr').disabled=true;
  try{
    const qrData=await imageData(file);
    const r=await api('/api/admin/payment-settings','PUT',{qrData});
    $('adminPaymentQrFile').value='';
    msg('adminPaymentQrMsg',r.message||'Payment QR saved.');
    await loadAdminPaymentSettings();
  }catch(e){msg('adminPaymentQrMsg',e.message||'Could not save payment QR.')}
  finally{$('saveAdminPaymentQr').disabled=false}
};

let completedHistoryOffset=0;
async function loadAdminOfferOrders(scope='active',append=false){
  try{
    if(scope==='completed'&&!append)completedHistoryOffset=0;
    const query='/api/admin/offer-orders?scope='+encodeURIComponent(scope)+(scope==='completed'?'&offset='+completedHistoryOffset:'');
    const r=await api(query);
    const adminOrders=r.orders||[];
    const runningAdminOrders=adminOrders.filter(x=>!['completed','cancelled','expired'].includes(x.orderStatus));
    const completedAdminOrders=adminOrders.filter(x=>x.orderStatus==='completed').sort((a,b)=>new Date(b.completedAt||b.updatedAt||b.confirmedAt||0)-new Date(a.completedAt||a.updatedAt||a.confirmedAt||0));
    const onlineAdminOrders=adminOrders.filter(x=>x.paymentMethod==='ONLINE_PAYMENT'&&(runningAdminOrders.some(r=>r.id===x.id)||(x.refund&&['requested','processing','success'].includes(x.refund.status))));
    const codAdminOrders=runningAdminOrders.filter(x=>x.paymentMethod==='CASH_ON_DELIVERY');
    const latestCancelledAdminOrders=adminOrders.filter(x=>x.orderStatus==='cancelled'||x.orderStatus==='expired').sort((a,b)=>new Date(b.cancelledAt||b.adminCancelledAt||b.confirmedAt||0)-new Date(a.cancelledAt||a.adminCancelledAt||a.confirmedAt||0));
    if(scope==='active'){
      const s=r.stats||{};
      $('newOrderCount').textContent=s.newOrders||0;
      $('oldOrderCount').textContent=s.oldOrders||0;
      $('completedOrderCount').textContent=s.completedOrders||0;
      $('todayOrderCount').textContent=s.todayOrders||0;
      $('pendingTodayCount').textContent=s.pendingToday||0;
      $('completedTodayCount').textContent=s.completedToday||0;
      const todayCustomers=r.todayCustomers||[];
      $('todayCustomerOrders').innerHTML=todayCustomers.length?todayCustomers.map(c=>`<div class="today-customer-row"><span>${esc(c.name)} · ${esc(c.mobile)}</span><b>${Number(c.count)} order(s)</b></div>`).join(''):'<p class="muted">No customer orders received today.</p>';
    }
    const renderAdminOrderCard=x=>{
      const items=(x.items||[]).map(i=>{
        const photo=(i.photoUrls||[])[0];
        return `<div class="compact-order-product">${photo?`<img src="${photo}" alt="Selected product">`:'<div class="no-photo">NO PHOTO</div>'}<div><b>${esc(i.productName)} × ${Number(i.quantity)}</b><small>${moneyPrice(i.offerPrice||i.lineTotal)}${Number(i.quantity)>1?' each':''} · Line ${moneyPrice(i.lineTotal)}</small></div></div>`;
      }).join('');
      const collected=x.collectionStatus==='collected',paid=x.paymentStatus==='received',online=x.paymentMethod==='ONLINE_PAYMENT',onlineSubmitted=online&&x.paymentStatus==='submitted',completed=x.orderStatus==='completed';
      const refund=x.refund||{};
      const status=refund.status==='success'?'REFUND SUCCESS':refund.status==='failed'?'REFUND FAILED':refund.status==='requested'?'REFUND REQUESTED':completed?'COMPLETED':x.orderStatus==='cancelled'?'CANCELLED':x.orderStatus==='expired'?'EXPIRED':onlineSubmitted?'ONLINE PAYMENT SUBMITTED':paid?(online?'ONLINE PAYMENT VERIFIED':'CASH RECEIVED'):collected?'COLLECTED':'NEW ORDER';
      return `<article class="compact-order"><div class="compact-order-head"><strong>ORDER #${esc(x.orderNumber)}</strong><span class="compact-order-status">${status}</span></div>
        <div class="compact-order-meta">${date(x.confirmedAt)}</div>
        <div class="compact-order-customer">${esc(x.customerName)}</div><div class="compact-order-phone">📞 ${esc(x.mobile)}</div>
        ${items}${x.adminCancellationMessage?`<div class="compact-order-details" style="background:#fff0ee;border:1px solid #d99b91"><b>ADMIN CANCELLATION MESSAGE:</b> ${esc(x.adminCancellationMessage)}</div>`:'' }<div class="compact-order-details"><b>Total: ${moneyPrice(x.total)}</b> · ${online?'ONLINE PAYMENT':'CASH ON DELIVERY'} · Payment: ${paid?'VERIFIED / RECEIVED':onlineSubmitted?'WAITING FOR VERIFICATION':'PENDING'}</div>${x.fulfilmentMode==='HOME_DELIVERY'?'<div class="compact-order-details"><b>HOME DELIVERY · ₹49 charge included</b><br>'+esc(x.deliveryAddress?.name||x.customerName)+' · '+esc(x.deliveryAddress?.mobile||x.mobile)+'<br>'+esc(x.deliveryAddress?.address||'')+', '+esc(x.deliveryAddress?.area||'')+'<br>Landmark: '+esc(x.deliveryAddress?.landmark||'—')+' · PIN: '+esc(x.deliveryAddress?.pincode||'')+'</div>':'<div class="compact-order-details"><b>VISIT SHOP & COLLECT</b></div>'}
        ${online?`<div class="payment-admin-proof"><b>UTR: ${esc(x.paymentUtr||'Not supplied')}</b>${x.paymentScreenshotData?`<a href="${esc(x.paymentScreenshotData)}" target="_blank" rel="noopener"><img class="payment-proof-thumb" src="${esc(x.paymentScreenshotData)}" alt="Customer payment screenshot"></a>`:'<small>Payment screenshot not available</small>'}</div>`:''}
        ${online&&refund.status?`<div class="payment-admin-proof"><b>REFUND UPDATE: ${esc(String(refund.status).toUpperCase())}</b><p><b>Account Holder:</b> ${esc(refund.holderName||'—')}</p><p><b>UPI ID / Number:</b> ${esc(refund.upiId||'—')}</p>${refund.refundUtr?`<p><b>Refund UTR:</b> ${esc(refund.refundUtr)}</p>`:''}${refund.customerMessage?`<p><b>Customer message:</b> ${esc(refund.customerMessage)}</p>`:''}${refund.message?`<p><b>Admin message:</b> ${esc(refund.message)}</p>`:''}${refund.screenshotData?`<p><b>Refund payment / update screenshot:</b></p><a href="${esc(refund.screenshotData)}" target="_blank" rel="noopener"><img class="payment-proof-thumb" src="${esc(refund.screenshotData)}" alt="Refund payment or update screenshot"></a>`:''}</div>
        ${refund.status!=='success'?`<div class="refund-admin-form"><label>Refund UTR Number (12 digits, when refund is sent)</label><input id="refund-utr-${esc(x.id)}" inputmode="numeric" maxlength="12" placeholder="Enter refund UTR number"><label>Refund payment screenshot / issue screenshot</label><input id="refund-shot-${esc(x.id)}" type="file" accept="image/*"><label>Message to customer (required)</label><textarea id="refund-msg-${esc(x.id)}" rows="3" maxlength="500" placeholder="Refund update or explain the error / delay"></textarea><div class="compact-order-actions"><button class="gold" data-refund-update="${esc(x.id)}">SAVE REFUND UPDATE</button></div><small>To mark refund successful, enter the 12-digit refund UTR and upload the refund payment screenshot. For an issue, upload its screenshot and explain it in the message; no FAILED option is used.</small></div>`:''}`:''}
        <div class="compact-order-details">Collection: ${collected?'COLLECTED':'PENDING'} · Stamps: ${x.stampsStatus==='added'?'UPDATED':'PENDING'}</div>
        <div class="compact-order-actions">${!completed&&!["cancelled","expired"].includes(x.orderStatus)&&!x.cancelledByAdmin&&onlineSubmitted?`<button class="gold" data-order-verify="${esc(x.id)}">VERIFY ONLINE PAYMENT</button>`:''}${!completed&&!['cancelled','expired'].includes(x.orderStatus)&&online&&paid&&['HOME_DELIVERY','SHOP_COLLECTION'].includes(x.fulfilmentMode)&&x.orderStatus!=='processing'&&!collected?'<button class="gold" data-order-processing="'+esc(x.id)+'">START PROCESSING</button>':''}${!completed&&!['cancelled','expired'].includes(x.orderStatus)&&x.orderStatus==='ready'&&!collected&&!online?'<button class="gold" data-order-collect="'+esc(x.id)+'">COLLECTED</button>':''}${!completed&&!['cancelled','expired'].includes(x.orderStatus)&&x.orderStatus==='processing'&&!collected?'<button class="gold" data-order-collect="'+esc(x.id)+'">'+(x.fulfilmentMode==='HOME_DELIVERY'?'DELIVERED':'COLLECTED')+'</button>':''}${!completed&&!["cancelled","expired"].includes(x.orderStatus)&&!collected&&!paid&&!online?`<button class="gold" data-order-payment="${esc(x.id)}">CASH RECEIVED</button>`:''}${!completed&&!["cancelled","expired"].includes(x.orderStatus)&&collected&&paid?`<button class="gold" data-order-complete="${esc(x.id)}">FINAL APPROVAL · ADD STAMPS</button>`:''}${!completed&&!collected&&!['cancelled','expired'].includes(x.orderStatus)&&!online?`<button class="cancel-reservation" data-order-cancel-cod="${esc(x.id)}">CANCEL COD ORDER</button>`:'' }${!completed&&!collected&&!['cancelled','expired'].includes(x.orderStatus)&&online?`<button class="cancel-reservation" data-order-cancel-online="${esc(x.id)}">CANCEL ONLINE ORDER</button>`:''}</div></article>`;
    };
    if(scope==='active'){
      const runningEl=$('dashboardRunningOrders');
      if(runningEl)runningEl.innerHTML=runningAdminOrders.slice(0,6).map(x=>`<div class="today-customer-row"><span><b>#${esc(x.orderNumber)}</b> · ${esc(x.customerName)} · ${esc(x.orderStatus||'pending')}</span><b>${moneyPrice(x.total)}</b></div>`).join('')||'<p class="muted">No pending or running orders.</p>';
      const runningList=$('adminRunningOrdersList');
      if(runningList)runningList.innerHTML=runningAdminOrders.map(renderAdminOrderCard).join('')||'<div class="order-empty">No pending or running orders.</div>';
      $('adminOnlineOrders').innerHTML=onlineAdminOrders.map(renderAdminOrderCard).join('')||'<div class="order-empty">No online payment orders found.</div>';
      $('adminCodOrders').innerHTML=codAdminOrders.map(renderAdminOrderCard).join('')||'<div class="order-empty">No cash on delivery orders found.</div>';
    }else{
      const historyEl=$('adminCompletedOrders');
      if(historyEl){
        const cards=completedAdminOrders.map(renderAdminOrderCard).join('');
        historyEl.innerHTML=(append?historyEl.innerHTML.replace(/<div id="loadMoreCompletedOrdersWrap"[\s\S]*?<\/div>$/,''): '')+
          (cards||(!append?'<div class="order-empty">No completed orders yet.</div>':''));
        completedHistoryOffset=Number(r.nextOffset||0);
        if(r.hasMore){
          const wrap=document.createElement('div');wrap.id='loadMoreCompletedOrdersWrap';wrap.style='text-align:center;margin:16px 0';
          wrap.innerHTML='<button type="button" class="secondary" id="loadMoreCompletedOrders">LOAD OLDER COMPLETED ORDERS</button>';
          historyEl.appendChild(wrap);
          $('loadMoreCompletedOrders').onclick=()=>loadAdminOfferOrders('completed',true);
        }
      }
      const cancelledOrdersEl=$('adminCancelledOrdersAll');
      if(cancelledOrdersEl)cancelledOrdersEl.innerHTML=latestCancelledAdminOrders.map(renderAdminOrderCard).join('')||'<div class="order-empty">No cancelled orders yet.</div>';
    }
    document.querySelectorAll('[data-order-cancel-cod],[data-order-cancel-online]').forEach(b=>b.onclick=async()=>{
      const reason=prompt('Enter the cancellation reason/message. This message will be shown to the customer:');
      if(reason===null)return;
      if(!reason.trim()){msg('offerOrderMsg','Please enter a cancellation message for the customer.');return;}
      if(!confirm('Cancel this order and show this message to the customer?'))return;
      b.disabled=true;
      try{const z=await api('/api/admin/orders/'+encodeURIComponent(b.dataset.orderCancelCod||b.dataset.orderCancelOnline)+'/cancel','POST',{message:reason.trim()});msg('offerOrderMsg',z.message);await loadAdminOfferOrders();await loadCustomerOrders()}
      catch(e){msg('offerOrderMsg',e.message);b.disabled=false}
    });
    document.querySelectorAll('[data-order-verify]').forEach(b=>b.onclick=async()=>{
      if(!confirm('Verify that the UTR and payment screenshot show the correct received payment?'))return;
      b.disabled=true;
      try{const z=await api('/api/admin/orders/'+encodeURIComponent(b.dataset.orderVerify)+'/verify-payment','POST',{});msg('offerOrderMsg',z.message);await loadAdminOfferOrders()}
      catch(e){msg('offerOrderMsg',e.message);b.disabled=false}
    });
    document.querySelectorAll('[data-order-processing]').forEach(b=>b.onclick=async()=>{if(!confirm('Start packing / order processing now? Customer cancellation will be disabled.'))return;b.disabled=true;try{const z=await api('/api/admin/orders/'+encodeURIComponent(b.dataset.orderProcessing)+'/processing','POST',{});msg('offerOrderMsg',z.message);await Promise.all([loadAdminOfferOrders(),loadCustomerOrders()])}catch(e){msg('offerOrderMsg',e.message);b.disabled=false}});
    document.querySelectorAll('[data-order-collect]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const z=await api('/api/admin/orders/'+encodeURIComponent(b.dataset.orderCollect)+'/collect','POST',{});msg('offerOrderMsg',z.message);await loadAdminOfferOrders()}catch(e){msg('offerOrderMsg',e.message);b.disabled=false}});
    document.querySelectorAll('[data-order-payment]').forEach(b=>b.onclick=async()=>{if(!confirm('Confirm that you received the full cash payment for this order?'))return;b.disabled=true;try{const z=await api('/api/admin/orders/'+encodeURIComponent(b.dataset.orderPayment)+'/payment','POST',{});msg('offerOrderMsg',z.message);await loadAdminOfferOrders()}catch(e){msg('offerOrderMsg',e.message);b.disabled=false}});
    document.querySelectorAll('[data-order-complete]').forEach(b=>b.onclick=async()=>{if(!confirm('Final approval: cash is received and customer has collected all products. Add bill and stamps now?'))return;b.disabled=true;try{const z=await api('/api/admin/orders/'+encodeURIComponent(b.dataset.orderComplete)+'/complete','POST',{});msg('offerOrderMsg',z.message);await Promise.all([loadAdminOfferOrders(),loadAdminProducts(),loadCustomers(),loadRewardEligible()]);if($('adminApp')?.dataset.activePage==='history')await loadAdminOfferOrders('history')}catch(e){msg('offerOrderMsg',e.message);b.disabled=false}});
    document.querySelectorAll('[data-refund-update]').forEach(b=>b.onclick=async()=>{
      const id=b.dataset.refundUpdate;
      const message=$('refund-msg-'+id)?.value.trim()||'';
      const refundUtr=$('refund-utr-'+id)?.value.trim()||'';
      const file=$('refund-shot-'+id)?.files?.[0];
      if(!message)return msg('offerOrderMsg','Please enter a message for the customer.');
      if(refundUtr && !/^\d{12}$/.test(refundUtr))return msg('offerOrderMsg','Enter the exact 12-digit refund UTR number.');
      if(refundUtr&&!file)return msg('offerOrderMsg','For successful refund, upload the refund payment screenshot along with the 12-digit refund UTR.');
      b.disabled=true;
      try{const body={message,refundUtr};if(file)body.screenshotData=await imageData(file);const z=await api('/api/admin/orders/'+encodeURIComponent(id)+'/refund','POST',body);msg('offerOrderMsg',z.message);await loadAdminOfferOrders(scope)}
      catch(e){msg('offerOrderMsg',e.message);b.disabled=false}
    });

  }catch(e){
    console.error('loadAdminOfferOrders failed:',e);
    const message=esc(e.message||'Could not load customer orders.');
    const targets=scope==='completed'?[$('adminCompletedOrders')]:scope==='history'?[$('adminCancelledOrdersAll')]:[$('adminRunningOrdersList'),$('adminOnlineOrders'),$('adminCodOrders')];
    targets.filter(Boolean).forEach(el=>{el.innerHTML='<div class="order-empty">Could not load orders: '+message+'</div>';});
    const notice=$('offerOrderMsg');
    if(notice){notice.textContent='Could not load orders: '+(e.message||'Please refresh and try again.');notice.classList.remove('hidden');}
  }
}
$('refreshOfferOrders').onclick=loadAdminOfferOrders;
$('refreshOrderDashboard').onclick=loadAdminOfferOrders;
$('refreshCompletedHistory')?.addEventListener('click',()=>{completedHistoryOffset=0;const el=$('adminCompletedOrders');if(el)el.innerHTML='<div class="order-empty">Loading completed orders…</div>';loadAdminOfferOrders('completed')});

async function loadCustomerOrders(){
  try{
    const r=await api('/api/customer/my-orders');
    customerOrdersCache=r.orders||[];
    const cancelledForDisplay = r.orders.filter(x=>x.orderStatus==='cancelled')
      .sort((a,b)=>new Date(b.cancelledAt || b.confirmedAt || 0)-new Date(a.cancelledAt || a.confirmedAt || 0));
    const latestCancelledId = cancelledForDisplay[0]?.id;
    const customerVisibleOrders = r.orders.filter(x=>x.orderStatus!=='cancelled' || x.id===latestCancelledId);
    $('customerOrders').innerHTML=customerVisibleOrders.map(x=>{
      const completed=x.orderStatus==='completed';
      const cancelled=x.orderStatus==='cancelled';
      const expired=x.orderStatus==='expired';
      const items=(x.items||[]).map(i=>`<li style="display:flex;align-items:center;gap:10px;margin:9px 0;list-style:none"><img src="${esc((i.photoUrls||[])[0]||'')}" alt="${esc(i.productName||'Product')}" style="width:58px;height:58px;object-fit:cover;border-radius:8px;border:1px solid #dfd2b5;flex:0 0 58px;display:${(i.photoUrls||[])[0]?'block':'none'}"><span>${esc(i.productName)} × ${Number(i.quantity)} — ${moneyPrice(i.lineTotal)}</span></li>`).join('');
      return `<div class="product-card customer-order-card" style="border:1px solid #d8c28c;background:#fffdf7">
        <strong>ORDER #${esc(x.orderNumber)}</strong>
        <p><b>Confirmed</b> · ${date(x.confirmedAt)}</p>
        ${completed?`<p class="price-offer">✓ ORDER COMPLETED</p><h3>Your Billing Stamps Updated 🙏</h3><p>Thank you for shopping. Please visit once again 🙏</p><p>Stamps added: ${Number(x.stampsAdded)}</p>`:cancelled?`<p class="muted">ORDER CANCELLED</p>${x.adminCancellationMessage?`<div class="card" style="background:#fff0ee;border:1px solid #d99b91"><b>MESSAGE FROM TANMAYI STORE AND GIFTS</b><p>${esc(x.adminCancellationMessage)}</p></div>`:''}`:expired?`<p class="muted">OFFER TIME EXPIRED · Please contact the shop if you still want this order.</p>`:x.paymentMethod==='ONLINE_PAYMENT'&&x.paymentStatus!=='received'?`<div class="card" style="background:#fff8e8;border:1px solid #e4cf9d"><h3 style="margin:0;color:#8a641d">🧾 BILL PROCESSING</h3><p>Your online payment is waiting for shop verification. The order will be ready after payment is verified.</p></div>`:x.paymentMethod==='ONLINE_PAYMENT'&&x.paymentStatus==='received'&&x.orderStatus==='processing'&&x.fulfilmentMode==='HOME_DELIVERY'?'<div class="card" style="background:#e8f3ff;border:2px solid #1672c4;text-align:center"><h2 style="margin:0;color:#0759a5;font-weight:900">🚚 YOUR ORDER IS ON THE WAY</h2></div>':x.paymentMethod==='ONLINE_PAYMENT'&&x.paymentStatus==='received'&&x.orderStatus==='processing'&&x.fulfilmentMode==='SHOP_COLLECTION'?'<div class="card" style="background:#eaf8ed;border:2px solid #278344;text-align:center"><h2 style="margin:0;color:#176b32;font-weight:900">📦 READY FOR PICKUP</h2><p>Your order is ready. Please visit the shop and collect it.</p></div>':x.fulfilmentMode==='HOME_DELIVERY'&&x.paymentStatus==='received'?'<div class="card" style="background:#eefaf0;border:1px solid #9ac9a1"><h3 style="margin:0;color:#24733a">🚚 PAYMENT VERIFIED · PREPARING YOUR ORDER</h3><p>Your order will be processed by the shop shortly.</p></div>':`<div class="card" style="background:#eefaf0;border:1px solid #9ac9a1"><h3 style="margin:0;color:#24733a">🚚 YOUR ORDER IS ARRIVING SOON!</h3><p>Your payment is verified. We are preparing your home delivery. Expected delivery within 1 hour from payment verification.</p><p><b>Delivery status:</b> ARRIVING SOON</p><p><b>Time remaining:</b> <strong data-arrival-countdown="${x.paymentVerifiedAt?Date.parse(x.paymentVerifiedAt)+3600000:0}">${x.paymentVerifiedAt?'Calculating…':'Delivery is being arranged'}</strong></p></div>`:x.fulfilmentMode==='HOME_DELIVERY'?`<div class="card" style="background:#fff8e8;border:1px solid #e4cf9d"><h3 style="margin:0;color:#8a641d">🧾 PAYMENT VERIFICATION PENDING</h3><p>Your home delivery will be prepared after online payment is verified by the shop.</p></div>`:x.paymentMethod==='ONLINE_PAYMENT'&&x.paymentStatus!=='received'?`<div class="card" style="background:#fff8e8;border:1px solid #e4cf9d"><h3 style="margin:0;color:#8a641d">🧾 BILL PROCESSING</h3><p>Your online payment is waiting for shop verification. The order will be ready after payment is verified.</p></div>`:`<div class="card" style="background:#fff8e8;border:1px solid #e4cf9d"><h3 style="margin:0;color:#8a641d">🎁 VISIT OUR SHOP AND COLLECT YOUR PRODUCT</h3><p>Cash on Delivery order. Please visit TANMAYI STORE AND GIFTS to collect your product and pay at the shop.</p></div>`}
        ${x.paymentMethod==='ONLINE_PAYMENT'&&!x.cancelledByAdmin?`<div class="payment-admin-proof"><b>ONLINE PAYMENT DETAILS</b><p>Payment UTR: ${esc(x.paymentUtr||'—')}</p>${x.paymentScreenshotData?`<a href="${esc(x.paymentScreenshotData)}" target="_blank" rel="noopener"><img class="payment-proof-thumb" src="${esc(x.paymentScreenshotData)}" alt="Your payment screenshot"></a>`:''}<p>Payment status: ${esc(x.paymentStatus||'submitted')}</p>${x.refund?.status?`<p><b>Refund status:</b> ${esc(String(x.refund.status).toUpperCase())}</p><p><b>Refund account:</b> ${esc(x.refund.holderName||'')} · ${esc(x.refund.upiId||'')}</p>${x.refund.refundUtr?`<p><b>Refund UTR:</b> ${esc(x.refund.refundUtr)}</p>`:''}${x.refund.message?`<p><b>Shop message:</b> ${esc(x.refund.message)}</p>`:''}${x.refund.screenshotData?`<p><b>Refund payment / update screenshot:</b></p><a href="${esc(x.refund.screenshotData)}" target="_blank" rel="noopener"><img class="payment-proof-thumb" src="${esc(x.refund.screenshotData)}" alt="Refund payment or issue screenshot"></a>`:''}`:''}</div>`:''}
        ${x.paymentStatus==='rejected'&&x.paymentRejectionMessage?`<div class="card" style="background:#fff0ee;border:1px solid #d99b91;margin:10px 0"><b>MESSAGE FROM TANMAYI STORE AND GIFTS</b><p>${esc(x.paymentRejectionMessage)}</p></div>`:''}
        <p><b>Products:</b></p><ul>${items}</ul><p><b>Total:</b> ${moneyPrice(x.total)}</p>
        ${!completed&&!cancelled&&!expired&&x.orderStatus!=='processing'&&!(x.paymentMethod==='ONLINE_PAYMENT'&&x.paymentStatus!=='received')?`<p class="countdown">Collect before: ${date(x.expiresAt)}</p>${x.paymentMethod==='ONLINE_PAYMENT'?`<div class="refund-request-box" id="refund-box-${esc(x.id)}"><button class="cancel-reservation" data-show-refund="${esc(x.id)}">Cancel Order</button><div class="hidden" id="refund-fields-${esc(x.id)}"><label>Bank Account Holder Name</label><input id="refund-holder-${esc(x.id)}" maxlength="100" placeholder="Enter account holder name"><label>UPI ID / UPI Number</label><input id="refund-upi-${esc(x.id)}" maxlength="100" placeholder="example@upi or mobile UPI"><button class="gold" data-submit-refund="${esc(x.id)}">Cancel &amp; Submit Refund Request</button></div></div>`:`<button class="cancel-reservation" data-cancel-order="${esc(x.id)}">Cancel Order</button>`}`:''}
      </div>`;
    }).join('')||'<p class="muted">No orders yet. Your confirmed orders will appear here.</p>';
    renderProfileOrders();renderBuyAgain();
    document.querySelectorAll('[data-cancel-order]').forEach(b=>b.onclick=async()=>{if(!confirm('Are you sure to cancel this order?'))return;b.disabled=true;try{await api('/api/customer/cancel-order','POST',{orderId:b.dataset.cancelOrder});await loadCustomerOrders();await loadCustomerProducts()}catch(e){alert(e.message);b.disabled=false}});
    document.querySelectorAll('[data-show-refund]').forEach(b=>b.onclick=()=>{$('refund-fields-'+b.dataset.showRefund).classList.remove('hidden');b.classList.add('hidden')});
    document.querySelectorAll('[data-submit-refund]').forEach(b=>b.onclick=async()=>{const id=b.dataset.submitRefund,holderName=$('refund-holder-'+id).value.trim(),upiId=$('refund-upi-'+id).value.trim();if(!holderName||!upiId){alert('Enter bank account holder name and UPI ID / number.');return}if(!confirm('Cancel this online payment order and submit refund request?'))return;b.disabled=true;try{const result=await api('/api/customer/cancel-order','POST',{orderId:id,holderName,upiId});alert(result.message||'Refund request submitted.');await loadCustomerOrders();await loadCustomerProducts()}catch(e){alert(e.message);b.disabled=false}});
  }catch(e){$('customerOrders').textContent=e.message||'Could not load your orders.'}
}
function renderProfileOrders(){const el=$('profileOrdersHistory');if(!el)return;const groups=[['Running',customerOrdersCache.filter(x=>!['completed','cancelled','expired'].includes(x.orderStatus))],['Completed',customerOrdersCache.filter(x=>x.orderStatus==='completed')],['Cancelled',customerOrdersCache.filter(x=>x.orderStatus==='cancelled')],['Expired',customerOrdersCache.filter(x=>x.orderStatus==='expired')]];el.innerHTML=groups.map(([title,items])=>`<div class="customer-order-group"><h4>${title} Orders (${items.length})</h4>${items.map(x=>`<div class="customer-product-card customer-order-card"><b>Order #${esc(x.orderNumber)}</b><p>${date(x.confirmedAt)} · ${esc(x.orderStatus)}</p><p>${(x.items||[]).map(i=>`${esc(i.productName)} × ${Number(i.quantity)}`).join(', ')}</p><b>${moneyPrice(x.total)}</b></div>`).join('')||'<p class="muted">No '+title.toLowerCase()+' orders.</p>'}</div>`).join('');}
function renderBuyAgain(){const el=$('customerBuyAgain');if(!el)return;const bought=new Map();customerOrdersCache.forEach(o=>(o.items||[]).forEach(i=>{if(i.productId)bought.set(i.productId,i.productName||'Product')}));const matches=customerProductsCache.filter(p=>bought.has(p.id)&&Number(p.availableStock??p.stock??0)>0);el.innerHTML=matches.map(p=>`<div class="customer-product-card"><b>${esc(p.name)}</b><div class="product-photos">${(p.photoUrls||[]).map(u=>`<img src="${esc(u)}" alt="${esc(p.name)}">`).join('')}</div><p><span class="price-old">${moneyPrice(p.originalPrice)}</span> <b class="price-offer">${moneyPrice(p.offerPrice)}</b></p><p class="stock-line">Available: ${Number(p.availableStock??p.stock??0)}</p><button data-buy-again="${esc(p.id)}" data-name="${esc(p.name)}" data-price="${Number(p.offerPrice)}">Buy Again</button></div>`).join('')||'<p class="muted">Your previous products are currently unavailable or out of stock.</p>';el.querySelectorAll('[data-buy-again]').forEach(b=>b.onclick=()=>{const selectedProduct=customerProductsCache.find(p=>p.id===b.dataset.buyAgain)||{};const existingSelection=pendingOfferCart.find(p=>p.productId===b.dataset.buyAgain);if(existingSelection){existingSelection.quantity=Math.max(1,Number(existingSelection.quantity)||1)+1;}else{pendingOfferCart.push({key:b.dataset.buyAgain,productId:b.dataset.buyAgain,productName:b.dataset.name,offerPrice:Number(b.dataset.price),quantity:1,photoUrls:Array.isArray(selectedProduct.photoUrls)?selectedProduct.photoUrls.slice(0,2):[]});}savePendingOfferCart();orderConfirmedData=null;openCustomerPanel('myList');placeOrderFlowAfterProduct(b.dataset.buyAgain);renderReservations([])});}
$('refreshMyOrders').onclick=loadCustomerOrders;

function placeOrderFlowAfterProduct(productId){
  let flow=$('orderFlowBackdrop');
  // Recover the checkout shell if a stale/partial customer page is missing it.
  if(!flow){
    flow=document.createElement('div');
    flow.id='orderFlowBackdrop';
    flow.className='order-flow-backdrop hidden';
    flow.setAttribute('aria-hidden','true');
    flow.innerHTML='<section class="order-flow-card" role="dialog" aria-modal="true" aria-labelledby="orderFlowTitle"><header class="order-flow-head"><div class="order-flow-headline"><h2 id="orderFlowTitle">TANMAYI STORE AND GIFTS</h2><button type="button" class="order-flow-close" id="orderFlowClose" aria-label="Close">×</button></div><div class="order-flow-progress"><span id="orderProgress1" class="active"></span><span id="orderProgress2"></span><span id="orderProgress3"></span></div></header><div class="order-flow-body"><div id="customerReservations"></div></div></section>';
    document.body.appendChild(flow);
    const closeButton=$('orderFlowClose');
    if(closeButton)closeButton.onclick=closeOrderFlow;
  }
  activeOfferAnchorId=productId||activeOfferAnchorId;
  const selectedId=String(activeOfferAnchorId||'');
  const selectedCard=Array.from(document.querySelectorAll('[data-product-card-id]')).find(card=>card.isConnected&&card.getAttribute('data-product-card-id')===selectedId);
  let mount=$('orderFlowMount');
  if(!mount){
    mount=document.createElement('div');
    mount.id='orderFlowMount';
    mount.className='order-flow-inline-mount';
  }
  const grid=$('customerProducts');
  const panel=$('customerPanel-myList');
  flow.removeAttribute('style');
  flow.classList.remove('hidden');
  flow.classList.add('inline-order-flow');
  flow.setAttribute('aria-hidden','false');
  if(flow.parentElement!==mount)mount.appendChild(flow);
  // Keep checkout beside the selected product where possible; otherwise use a safe visible fallback.
  if(selectedCard){
    selectedCard.appendChild(mount);
  }else if(grid){
    if(mount.parentElement!==grid)grid.appendChild(mount);
  }else if(panel){
    if(mount.parentElement!==panel)panel.appendChild(mount);
  }else if(!mount.isConnected){
    document.body.appendChild(mount);
  }
  mount.hidden=false;
  mount.style.display='block';
  mount.style.position='static';
  mount.style.width='100%';
  mount.style.maxWidth='100%';
  mount.style.gridColumn='1 / -1';
  mount.style.margin='10px 0 0';
  flow.style.display='block';
  flow.style.position='static';
  flow.style.inset='auto';
  flow.style.zIndex='auto';
  return true;
}
function renderInlineProductSelections(){
  const grid=$('customerProducts');
  if(!grid)return;
  grid.querySelectorAll('[data-product-card-id]').forEach(card=>{
    const id=card.getAttribute('data-product-card-id');
    const selected=pendingOfferCart.find(item=>item.productId===id);
    const area=card.querySelector('[data-inline-selection]');
    const button=card.querySelector('[data-stage-offer]');
    if(!area||!button)return;
    if(!selected){
      area.hidden=true;
      area.innerHTML='';
      // Reset the product button after cart cancellation so it can be selected again.
      const product=customerProductsCache.find(item=>item.id===id)||{};
      const available=Math.max(0,Number(product.availableStock??product.stock??0));
      button.textContent=available>0?'Select & Add':'No stock available';
      button.disabled=available<=0;
      return;
    }
    const qty=Math.max(1,Number(selected.quantity)||1);
    const product=customerProductsCache.find(item=>item.id===id)||{};
    const photo=(Array.isArray(product.photoUrls)&&product.photoUrls[0])||(selected.photoUrls||[])[0]||'';
    area.hidden=false;
    area.innerHTML='<span class="inline-selected-badge">✓ ADDED TO YOUR ORDER</span><div class="inline-selected-summary">'+(photo?'<img src="'+esc(photo)+'" alt="'+esc(selected.productName)+' selected product">':'<span class="inline-selected-no-photo">No image</span>')+'<span><b>Selected quantity: '+qty+'</b><small>'+moneyPrice(Number(selected.offerPrice)*qty)+'</small></span></div>';
    const available=Math.max(0,Number(product.availableStock??product.stock??0));
    button.textContent=available<=qty?'Added to order':'Add another';
    button.disabled=available<=qty;
  });
}
async function loadCustomerProducts(){
  const productsMount=$('customerProducts');
  if(productsMount)productsMount.textContent='Loading products, please wait…';
  let reservations=[];
  try{
    // Show the product catalogue as soon as its essential request completes.
    // Reservations and payment QR are secondary and must not delay product cards.
    const r=await api('/api/customer/offers');
    customerProductsCache=r.products||[];
    pendingOfferCart=pendingOfferCart.map(item=>{
      const latest=customerProductsCache.find(p=>p.id===item.productId);
      return latest?{...item,productName:latest.name,offerPrice:Number(latest.offerPrice),photoUrls:Array.isArray(latest.photoUrls)?latest.photoUrls.slice(0,2):item.photoUrls}:item;
    });
    savePendingOfferCart();
    $('customerProducts').innerHTML=customerProductsCache.map((x,index)=>{
      const pendingCount=pendingOfferCart.filter(p=>p.productId===x.id).reduce((n,p)=>n+Math.max(1,Number(p.quantity)||1),0);
      const available=Math.max(0,Number(x.availableStock??x.stock??0));const canAddMore=available>pendingCount;
      const photos=Array.isArray(x.photoUrls)?x.photoUrls.slice(0,2):[];
      return `<div class="product-card" data-product-card-id="${esc(x.id)}">
        <strong>${esc(x.name)}</strong>
        <div class="customer-product-topline">${x.isNew?'<span class="product-new-badge">NEW ARRIVAL</span>':''}${photos.length>1?'<span class="product-photo-hint">📸 2 PHOTOS · SWIPE LEFT / RIGHT <span class="photo-arrow">↔</span></span>':''}</div>
        <div class="product-photos">${photos.map((u,i)=>`<img src="${esc(u)}" alt="${esc(x.name)} photo ${i+1}" data-zoom-product-image="${esc(u)}" loading="lazy" decoding="async">`).join('')}</div>
        <div class="customer-product-price-row"><p class="customer-product-prices"><span class="price-old">${moneyPrice(x.originalPrice)}</span> <span class="price-offer">${moneyPrice(x.offerPrice)}</span></p></div>
        <div class="customer-product-info-row">${x.size?`<p class="stock-line"><b>Size:</b> ${esc(x.size)}</p>`: '<span></span>'}${x.description?`<details class="customer-product-description"><summary>Description</summary><p>${esc(x.description)}</p></details>`:''}</div>
        <div class="customer-product-actions-row">
        <button type="button" class="secondary" disabled>${available<=0?'NO STOCK':`Stock: ${available}`}</button>
        <button type="button" data-stage-offer="${esc(x.id)}" data-name="${esc(x.name)}" data-price="${Number(x.offerPrice)}" ${!canAddMore?'disabled':''}>${available<=0?'No stock':!canAddMore?'Added':'Select &amp; Add'}</button></div>
        <div class="inline-product-selection" data-inline-selection="${esc(x.id)}" ${pendingCount?'':'hidden'}>
          ${pendingCount?'<span class="inline-selected-badge">✓ ADDED TO YOUR ORDER</span><div class="inline-selected-summary">'+(photos[0]?'<img src="'+esc(photos[0])+'" alt="'+esc(x.name)+' selected product">':'<span class="inline-selected-no-photo">Product</span>')+'<span><b>'+pendingCount+' selected</b><small>'+moneyPrice(Number(x.offerPrice)*pendingCount)+'</small></span></div>':''}
        </div>
      </div>`;
    }).join('')||'<p class="muted">No active offers right now.</p>';
    if(pendingOfferCart.length&&!orderConfirmedData)placeOrderFlowAfterProduct(activeOfferAnchorId||pendingOfferCart[pendingOfferCart.length-1].productId);
    renderInlineProductSelections();

    document.querySelectorAll('[data-stage-offer]').forEach(b=>b.onclick=e=>{
      e.preventDefault();e.stopPropagation();
      // Selecting a product opens its inline checkout immediately below that product.
      paymentStepOpen=true;
      selectedOrderPaymentMethod=selectedOrderPaymentMethod||"CASH_ON_DELIVERY";
      const selectedProduct=customerProductsCache.find(p=>p.id===b.dataset.stageOffer)||{};
      startCustomerCartExpiry();
      const existingSelection=pendingOfferCart.find(p=>p.productId===b.dataset.stageOffer);
      if(existingSelection){existingSelection.quantity=Math.max(1,Number(existingSelection.quantity)||1)+1;}
      else{pendingOfferCart.push({key:b.dataset.stageOffer,productId:b.dataset.stageOffer,productName:b.dataset.name,offerPrice:Number(b.dataset.price),quantity:1,photoUrls:Array.isArray(selectedProduct.photoUrls)?selectedProduct.photoUrls.slice(0,2):[]});}
      savePendingOfferCart();orderConfirmedData=null;
      placeOrderFlowAfterProduct(b.dataset.stageOffer);
      renderInlineProductSelections();
      renderReservations(reservations);
      // Load the existing shop QR as soon as inline payment choices are opened.
      api('/api/customer/payment-settings').then(settings=>{
        customerPaymentQr=settings?.qrData||'';
        if(paymentStepOpen&&pendingOfferCart.some(item=>item.productId===b.dataset.stageOffer)){
          renderReservations(reservations);
        }
      }).catch(error=>console.warn('Customer payment QR refresh failed:',error.message));
    });
    renderReservations(reservations);
    renderBuyAgain();

    // Load order reservations in the background; the catalogue is already usable.
    api('/api/customer/my-offers').then(m=>{
      reservations=Array.isArray(m.reservations)?m.reservations:[];
      const flow=$('orderFlowBackdrop');
      const orderFlowOpen=flow&&!flow.classList.contains('hidden');
      if(!orderFlowOpen&&!paymentStepOpen&&!orderConfirmedData)renderReservations(reservations);
    }).catch(error=>console.warn('Customer reservations loaded later:',error.message));
  }catch(e){
    console.error('Customer product offers failed:',e);
    const mount=$('customerProducts');
    if(mount)mount.textContent='Products are taking longer to load. Please wait a moment and tap Refresh to try again.';
  }
}
function renderReservations(items){
  const el=$('customerReservations');if(!el)return;
  $('orderProgress1').classList.add('active');$('orderProgress2').classList.toggle('active',!!paymentStepOpen);$('orderProgress3').classList.toggle('active',!!orderConfirmedData);
  if(orderConfirmedData){
    const o=orderConfirmedData.order||{};
    const online=orderConfirmedData.paymentMethod==='ONLINE_PAYMENT';const homeDelivery=orderConfirmedData.fulfilmentMode==='HOME_DELIVERY';
    $('orderProgress1').classList.add('active');$('orderProgress2').classList.add('active');$('orderProgress3').classList.add('active');
    el.innerHTML=`<div class="order-flow-success"><div class="success-mark">✓</div><h2>ORDER CONFIRMED SUCCESSFULLY</h2><p class="order-number">ORDER #${esc(o.orderNumber||'—')}</p><div class="order-flow-stage confirm-stage"><p><b>Order Total: ${moneyPrice(o.total||0)}</b></p><p><b>Delivery:</b> ${homeDelivery?'HOME DELIVERY · Estimated delivery within 30 minutes':'VISIT SHOP & COLLECT'}</p><p><b>Payment:</b> ${online?'ONLINE PAYMENT – SUBMITTED FOR VERIFICATION':homeDelivery?'CASH ON DELIVERY':'CASH ON DELIVERY – PAY AT SHOP'}</p><p><b>Order Status:</b> CONFIRMED</p></div><p class="order-flow-note">${homeDelivery?'Your order is confirmed. Estimated delivery within 30 minutes. Delivery charge ₹49 is included.':online?'Your payment details have been submitted. Shop verification is pending.':'Your order has been received. Please visit TANMAYI STORE AND GIFTS to collect and pay.'}</p><p class="order-flow-note">Order details are saved. You can view status in My Orders.</p><div class="order-flow-actions"><button type="button" class="continue-btn" id="orderFlowViewOrders">VIEW MY ORDERS</button><button type="button" class="back-btn" id="orderFlowDone">DONE</button></div></div>`;
    $('orderFlowViewOrders').onclick=()=>{closeOrderFlow();openCustomerPanel('orders')};$('orderFlowDone').onclick=closeOrderFlow;
    return;
  }
  const staged=pendingOfferCart.map(x=>{const qty=Math.max(1,Number(x.quantity)||1);return `<div class="product-card pending-cart-card">${x.photoUrls?.[0]?`<img class="selected-product-photo" src="${esc(x.photoUrls[0])}" alt="${esc(x.productName)}" data-zoom-product-image="${esc(x.photoUrls[0])}">`:'<div class="selected-product-photo" style="display:grid;place-items:center;color:#777;font-size:11px">No image</div>'}<div class="selected-product-info"><strong>${esc(x.productName)}</strong><span class="pending-price">${moneyPrice(x.offerPrice)} each</span><div class="pending-qty-controls"><button type="button" data-qty-minus="${esc(x.productId)}">−</button><span class="pending-qty">${qty}</span><button type="button" data-qty-plus="${esc(x.productId)}">+</button><button type="button" class="pending-remove-btn" data-remove-staged="${esc(x.productId)}">Cancel</button></div><b>${moneyPrice(Number(x.offerPrice)*qty)}</b></div></div>`}).join('');
  const confirmed=(items||[]).map(x=>`<div class="product-card" data-expiry="${Number(x.expiresAt)}"><strong>${esc(x.productName)}</strong> · ${moneyPrice(x.offerPrice)}<span class="countdown" data-countdown="${Number(x.expiresAt)}"></span><div class="collection-notice">Collect at TANMAYI STORE AND GIFTS before this offer expires.</div><button class="cancel-reservation" data-cancel-reservation="${esc(x.id)}">Cancel selection</button></div>`).join('');
  const total=pendingOfferCart.reduce((n,x)=>n+Math.max(1,Number(x.quantity)||1),0)+(items||[]).length;
  $('selectedOfferCount').textContent=`Selected items: ${total}`;
  const deliveryChoice=pendingOfferCart.length&&paymentStepOpen?`<div class="order-flow-stage"><p class="order-flow-step-title">CHOOSE DELIVERY OPTION</p><div class="payment-choice"><label><input type="radio" name="fulfilmentMode" value="SHOP_COLLECTION" ${selectedFulfilmentMode==="SHOP_COLLECTION"?"checked":""}> Visit Shop & Collect – Free</label><label><input type="radio" name="fulfilmentMode" value="HOME_DELIVERY" ${selectedFulfilmentMode==="HOME_DELIVERY"?"checked":""}> Home Delivery – ₹49 extra</label></div><div id="homeDeliveryFields" class="online-payment-fields ${selectedFulfilmentMode==="HOME_DELIVERY"?"":"hidden"}"><b>Home Delivery Address</b><label>Name</label><input id="deliveryName" maxlength="80" autocomplete="name"><label>Mobile Number</label><input id="deliveryMobile" inputmode="numeric" maxlength="10"><label>Address</label><textarea id="deliveryAddress" rows="2" maxlength="250"></textarea><label>Area</label><input id="deliveryArea" maxlength="100"><label>Landmark</label><input id="deliveryLandmark" maxlength="100"><label>PIN Code</label><input id="deliveryPincode" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="Enter 6-digit PIN code"><button type="button" class="secondary" id="getDeliveryLocation">📍 USE CURRENT LOCATION</button><p id="deliveryLocationStatus" class="muted">Enter PIN code and share GPS location. Home delivery is available only for PIN 517408 within 12 km of the shop.</p><p><b>Delivery charge: ₹49</b></p></div></div>`:"";
  const deliveryPaymentSummary=selectedFulfilmentMode==='HOME_DELIVERY'?'<div class="card" style="background:#eefaf0;border:1px solid #9ac9a1;margin:8px 0;padding:12px"><h3 style="margin:0 0 8px;color:#24733a">HOME DELIVERY PAYMENT BILL</h3><p style="margin:4px 0">Product total: <b>'+moneyPrice(pendingOfferCart.reduce((sum,x)=>sum+Number(x.offerPrice||0)*Math.max(1,Number(x.quantity)||1),0))+'</b></p><p style="margin:4px 0">Home delivery charge: <b>₹49</b></p><p style="margin:8px 0 0;font-size:18px">TOTAL PAY: <b>'+moneyPrice(pendingOfferCart.reduce((sum,x)=>sum+Number(x.offerPrice||0)*Math.max(1,Number(x.quantity)||1),0)+49)+'</b></p></div>':'';
  const paymentChoice=pendingOfferCart.length&&paymentStepOpen?`<div class="order-flow-stage payment-stage"><p class="order-flow-step-title">STEP 2 · CHOOSE PAYMENT</p><strong>Payment method</strong><div class="payment-choice">${selectedFulfilmentMode==='HOME_DELIVERY'?'<label><input type="radio" name="orderPaymentMethod" value="ONLINE_PAYMENT" checked> Online Payment – Home Delivery</label>':'<label><input type="radio" name="orderPaymentMethod" value="CASH_ON_DELIVERY" checked> Cash on Delivery – Visit Shop</label><label><input type="radio" name="orderPaymentMethod" value="ONLINE_PAYMENT"> Online Payment – Visit Shop</label>'}<div id="onlinePaymentFields" class="online-payment-fields hidden">${deliveryPaymentSummary}${customerPaymentQr?`<p style="font-size:12px;margin:4px 0"><b>Shop UPI QR</b></p><img class="customer-payment-qr" src="${esc(customerPaymentQr)}" alt="Shop UPI QR code">`:'<p class="muted">Shop payment QR code is not uploaded yet. Please choose another payment option or contact the shop.'}<label>Upload Payment Screenshot</label><input type="file" id="onlinePaymentScreenshot" accept="image/*"><label>Enter 12-digit UTR Number</label><input type="text" id="onlinePaymentUtr" inputmode="numeric" maxlength="12" placeholder="12-digit UTR number"></div></div></div>`:'';

  el.innerHTML=`<p class="order-flow-step-title">${paymentStepOpen?'STEP 2 · PAYMENT DETAILS':'STEP 1 · YOUR SELECTED PRODUCTS'}</p>${staged?`<div class="order-flow-stage"><div class="pending-cart-grid">${staged}</div><p style="font-size:12px;margin:8px 0 0"><b>${pendingOfferCart.reduce((n,x)=>n+Math.max(1,Number(x.quantity)||1),0)} piece(s)</b> · Total: ${moneyPrice(pendingOfferCart.reduce((a,x)=>a+Number(x.offerPrice||0)*Math.max(1,Number(x.quantity)||1),0))}</p></div>`:''}${deliveryChoice}${paymentChoice}${pendingOfferCart.length?`<div class="order-flow-actions">${paymentStepOpen?'<button type="button" class="back-btn" id="orderFlowBack">BACK</button>':'<button type="button" class="back-btn pending-addmore-btn" id="orderFlowAddMore">ADD MORE</button>'}<button type="button" class="continue-btn pending-payment-btn" id="confirmOffersButton">${paymentStepOpen?(selectedOrderPaymentMethod==='ONLINE_PAYMENT'?'CONFIRM PAYMENT & ORDER':'CONFIRM ORDER'):'CONTINUE TO PAYMENT'}</button></div>`:''}${!pendingOfferCart.length&&!confirmed?'<p class="muted">No products selected.</p>':''}`;
  function evaluateDeliveryAvailability(){
    if(selectedFulfilmentMode!=='HOME_DELIVERY')return true;
    const status=$('deliveryLocationStatus'),pin=$('deliveryPincode')?.value.trim()||'';
    let available=false,message='';
    if(!/^\d{6}$/.test(pin))message='Please enter a valid 6-digit PIN code.';
    else if(pin!=='517408')message='Home delivery not available at this location or pincode. Delivery is available only for PIN 517408.';
    else if(!deliveryCoordinates)message='PIN 517408 entered. Tap USE CURRENT LOCATION to check the 12 km delivery radius.';
    else{
      const rad=n=>n*Math.PI/180,lat=deliveryCoordinates.latitude,lon=deliveryCoordinates.longitude;
      const dLat=rad(lat-13.217485),dLon=rad(lon-78.738013);
      const a=Math.sin(dLat/2)**2+Math.cos(rad(13.217485))*Math.cos(rad(lat))*Math.sin(dLon/2)**2;
      const distance=6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      if(distance>12)message='Home delivery not available. Your location is '+distance.toFixed(1)+' km from the shop; delivery is limited to 12 km.';
      else{available=true;message='Home delivery available. Your location is '+distance.toFixed(1)+' km from the shop (within 12 km).';}
    }
    if(status){status.textContent=message;status.style.color=available?'#24733a':'#b3262d';}
    const confirm=$('confirmOffersButton');
    if(confirm&&paymentStepOpen&&selectedFulfilmentMode==='HOME_DELIVERY')confirm.disabled=!available;
    return available;
  }
  document.querySelectorAll('input[name="fulfilmentMode"]').forEach(r=>r.onchange=()=>{selectedFulfilmentMode=r.value;selectedOrderPaymentMethod=r.value==='HOME_DELIVERY'?'ONLINE_PAYMENT':'CASH_ON_DELIVERY';deliveryCoordinates=null;renderReservations(items)});
  const pinInput=$('deliveryPincode');if(pinInput){pinInput.oninput=()=>{pinInput.value=pinInput.value.replace(/\D/g,'').slice(0,6);evaluateDeliveryAvailability();};pinInput.onchange=evaluateDeliveryAvailability;}
  const locationButton=$('getDeliveryLocation');if(locationButton)locationButton.onclick=()=>{
    const status=$('deliveryLocationStatus');
    if(!navigator.geolocation){if(status)status.textContent='GPS is not supported by this browser.';return;}
    if(status)status.textContent='Getting your current location…';
    locationButton.disabled=true;
    navigator.geolocation.getCurrentPosition(pos=>{
      deliveryCoordinates={latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy:pos.coords.accuracy};
      locationButton.disabled=false;
      evaluateDeliveryAvailability();
    },err=>{
      if(status)status.textContent=err.code===1?'Location permission denied. Allow location access and try again.':'Could not get location. Enable GPS and retry.';
      locationButton.disabled=false;
      deliveryCoordinates=null;
      evaluateDeliveryAvailability();
    },{enableHighAccuracy:true,timeout:15000,maximumAge:0});
  };
  if(selectedFulfilmentMode==='HOME_DELIVERY')evaluateDeliveryAvailability();document.querySelectorAll('input[name="orderPaymentMethod"]').forEach(r=>r.onchange=()=>{selectedOrderPaymentMethod=r.value;const online=r.value==='ONLINE_PAYMENT';$('onlinePaymentFields')?.classList.toggle('hidden',!online);const b=$('confirmOffersButton');if(b)b.textContent=online?'CONFIRM PAYMENT & ORDER':'CONFIRM ORDER';$('orderFlowBackdrop').querySelector('.payment-stage')?.classList.toggle('payment-stage',true)});
  if(selectedFulfilmentMode==='HOME_DELIVERY')selectedOrderPaymentMethod='ONLINE_PAYMENT';const onlineFields=$('onlinePaymentFields');if(onlineFields)onlineFields.classList.toggle('hidden',selectedOrderPaymentMethod!=='ONLINE_PAYMENT');
  const utrInput=$('onlinePaymentUtr');if(utrInput)utrInput.oninput=()=>{const digits=utrInput.value.replace(/[^0-9]/g,'').slice(0,12);if(utrInput.value!==digits)utrInput.value=digits;};
  const confirmButton=$('confirmOffersButton');if(confirmButton)confirmButton.onclick=async()=>{
    if(!paymentStepOpen){paymentStepOpen=true;try{const latestPaymentSettings=await api('/api/customer/payment-settings');customerPaymentQr=latestPaymentSettings.qrData||'';}catch(_){}renderReservations(items);return;}
    if(selectedFulfilmentMode==='HOME_DELIVERY'&&!evaluateDeliveryAvailability())return;
    confirmButton.disabled=true;
    try{
      if(!pendingOrderRequestId)pendingOrderRequestId=(crypto.randomUUID?crypto.randomUUID():('req_'+Date.now()+'_'+Math.random().toString(36).slice(2)));
      const paymentMethod=selectedFulfilmentMode==='HOME_DELIVERY'?'ONLINE_PAYMENT':(document.querySelector('input[name="orderPaymentMethod"]:checked')?.value||selectedOrderPaymentMethod||'CASH_ON_DELIVERY');
      const payload={productIds:pendingOfferCart.flatMap(x=>Array(Math.max(1,Number(x.quantity)||1)).fill(x.productId)),clientRequestId:pendingOrderRequestId,paymentMethod};if(selectedFulfilmentMode==='HOME_DELIVERY'){if(!deliveryCoordinates)throw Error('Please tap USE CURRENT LOCATION and allow GPS permission.');payload.fulfilmentMode='HOME_DELIVERY';payload.deliveryAddress={name:$('deliveryName').value.trim(),mobile:$('deliveryMobile').value.replace(/\D/g,''),address:$('deliveryAddress').value.trim(),area:$('deliveryArea').value.trim(),landmark:$('deliveryLandmark').value.trim(),pincode:$('deliveryPincode').value.trim()};payload.customerLatitude=deliveryCoordinates.latitude;payload.customerLongitude=deliveryCoordinates.longitude;}else payload.fulfilmentMode='SHOP_COLLECTION';
      if(paymentMethod==='ONLINE_PAYMENT'){
        if(!customerPaymentQr)throw Error('Shop online payment QR is not available yet. Please choose Cash on Delivery or contact the shop.');
        const utr=String($('onlinePaymentUtr')?.value||'').replace(/[^0-9]/g,'');if($('onlinePaymentUtr'))$('onlinePaymentUtr').value=utr;
        const screenshotFile=$('onlinePaymentScreenshot')?.files?.[0];if(utr.length!==12)throw Error('UTR must contain exactly 12 digits. Website detected '+utr.length+' digit(s). Please check the UTR field.');if(!screenshotFile)throw Error('Please upload your payment screenshot.');payload.paymentUtr=utr;payload.paymentScreenshot=await imageData(screenshotFile);
      }
      const orderResult=await api('/api/customer/confirm-offers','POST',payload);
      pendingOrderRequestId=null;pendingOfferCart=[];savePendingOfferCart();paymentStepOpen=false;selectedOrderPaymentMethod='CASH_ON_DELIVERY';orderConfirmedData={order:orderResult.order||{},paymentMethod,fulfilmentMode:selectedFulfilmentMode};
      renderReservations([]);await loadCustomerOrders();
    }catch(e){alert(e.message);confirmButton.disabled=false}
  };
  const back=$('orderFlowBack');if(back)back.onclick=()=>{paymentStepOpen=false;selectedOrderPaymentMethod='CASH_ON_DELIVERY';renderReservations(items)};
  const addMore=$('orderFlowAddMore');if(addMore)addMore.onclick=closeOrderFlow;
  document.querySelectorAll('[data-qty-minus]').forEach(b=>b.onclick=()=>{const x=pendingOfferCart.find(p=>p.productId===b.dataset.qtyMinus);if(!x)return;x.quantity=Math.max(1,Number(x.quantity)||1)-1;if(x.quantity<=0)pendingOfferCart=pendingOfferCart.filter(p=>p.productId!==b.dataset.qtyMinus);savePendingOfferCart();if(!pendingOfferCart.length){paymentStepOpen=false;selectedOrderPaymentMethod='CASH_ON_DELIVERY';}renderReservations(items);loadCustomerProducts()});
  document.querySelectorAll('[data-qty-plus]').forEach(b=>b.onclick=()=>{const x=pendingOfferCart.find(p=>p.productId===b.dataset.qtyPlus);if(!x)return;const product=customerProductsCache.find(p=>p.id===x.productId);const available=Math.max(0,Number(product?.availableStock??product?.stock??0));const qty=Math.max(1,Number(x.quantity)||1);if(qty>=available){alert('Only '+available+' piece(s) are available.');return;}x.quantity=qty+1;savePendingOfferCart();renderReservations(items);loadCustomerProducts()});
  document.querySelectorAll('[data-remove-staged]').forEach(b=>b.onclick=()=>{pendingOfferCart=pendingOfferCart.filter(x=>x.productId!==b.dataset.removeStaged);savePendingOfferCart();if(!pendingOfferCart.length){paymentStepOpen=false;selectedOrderPaymentMethod='CASH_ON_DELIVERY';}renderReservations(items);loadCustomerProducts()});
  document.querySelectorAll('[data-cancel-reservation]').forEach(b=>b.onclick=async()=>{if(!confirm('Cancel this confirmed offer?'))return;b.disabled=true;try{await api('/api/customer/cancel-offer','POST',{reservationId:b.dataset.cancelReservation});await loadCustomerProducts()}catch(e){alert(e.message);b.disabled=false}});
  updateCountdowns();
}
function closeOrderFlow(){const modal=$('orderFlowBackdrop');if(modal){modal.classList.add('hidden');modal.setAttribute('aria-hidden','true');modal.classList.remove('inline-order-flow');document.body.appendChild(modal)}if(orderConfirmedData){orderConfirmedData=null;pendingOfferCart=[];savePendingOfferCart();paymentStepOpen=false;selectedOrderPaymentMethod='CASH_ON_DELIVERY';loadCustomerProducts()}else{paymentStepOpen=false;selectedOrderPaymentMethod='CASH_ON_DELIVERY'}}
$('orderFlowClose').onclick=closeOrderFlow;
document.addEventListener('click',e=>{const im=e.target.closest('[data-zoom-product-image]');if(im){const z=$('selectedImageZoom');$('selectedImageZoomPhoto').src=im.dataset.zoomProductImage;z.hidden=false;}});
function closeSelectedImageZoom(){const z=$('selectedImageZoom');if(z){z.hidden=true;$('selectedImageZoomPhoto').removeAttribute('src');}}
$('selectedImageZoomClose').onclick=closeSelectedImageZoom;$('selectedImageZoom').onclick=e=>{if(e.target.id==='selectedImageZoom')closeSelectedImageZoom();};
function showPaymentConfirmationPopup(){
  const popup=$('paymentConfirmPopup');
  popup.classList.remove('hidden');popup.setAttribute('aria-hidden','false');
}
function hidePaymentConfirmationPopup(){
  const popup=$('paymentConfirmPopup');
  popup.classList.add('hidden');popup.setAttribute('aria-hidden','true');
}
$('paymentPopupOkay').onclick=$('paymentPopupNo').onclick=$('paymentPopupClose').onclick=hidePaymentConfirmationPopup;
function updateCountdowns(){document.querySelectorAll('[data-countdown]').forEach(el=>{const left=Number(el.dataset.countdown)-Date.now();if(left<=0){el.textContent='Offer expired';el.closest('[data-expiry]')?.classList.add('muted')}else{const h=Math.floor(left/3600000),m=Math.floor(left%3600000/60000),s=Math.floor(left%60000/1000);el.textContent=` · Expires in ${h}h ${m}m ${s}s`}});document.querySelectorAll('[data-arrival-countdown]').forEach(el=>{const deadline=Number(el.dataset.arrivalCountdown),left=deadline-Date.now();if(!deadline){el.textContent='Delivery is being arranged';return;}if(left<=0){el.textContent='1-hour delivery window reached · Please contact the shop';return;}const m=Math.floor(left/60000),s=Math.floor(left%60000/1000);el.textContent=m+' min '+s+' sec';});}
setInterval(updateCountdowns,1000);
$('saveProduct').onclick=async()=>{clear('productAdminMsg');const name=$('productName').value.trim(),size=$('productSize').value.trim(),description=$('productDescription').value.trim(),originalPrice=Number($('productOriginal').value),offerPrice=Number($('productOffer').value),stock=Number($('productStock').value),f1=$('productPhoto1').files[0],f2=$('productPhoto2').files[0];if(!name||!Number.isFinite(originalPrice)||originalPrice<=0||!Number.isFinite(offerPrice)||offerPrice<=0||offerPrice>=originalPrice||!Number.isInteger(stock)||stock<0||!f1||!f2)return msg('productAdminMsg','Enter product name, valid prices, stock (whole number) and both photos.');$('saveProduct').disabled=true;try{const photo1=await imageData(f1),photo2=await imageData(f2);await api('/api/admin/products','POST',{name,size,description,originalPrice,offerPrice,stock,photo1,photo2});$('productName').value=$('productSize').value=$('productDescription').value=$('productOriginal').value=$('productOffer').value=$('productStock').value='';$('productPhoto1').value=$('productPhoto2').value='';msg('productAdminMsg','Product and offer uploaded successfully.');await loadAdminProducts()}catch(e){msg('productAdminMsg',e.message)}finally{$('saveProduct').disabled=false}};

const adminRoute=new URLSearchParams(location.search).get('admin')==='1';if(adminRoute){$('adminLogin').classList.remove('hidden');$('publicStorefront')?.classList.add('hidden');}
$('toggleCustomerHistory').onclick=()=>{const panel=$('customerHistoryPanel'),opening=panel.classList.contains('hidden');panel.classList.toggle('hidden',!opening);$('toggleCustomerHistory').setAttribute('aria-expanded',String(opening));$('toggleCustomerHistory').textContent=opening?'📋 My Bill History　▲':'📋 My Bill History　▼'};
function openCustomerPanel(name){document.querySelectorAll('[id^="customerPanel-"]').forEach(p=>p.classList.add('hidden'));const panel=$('customerPanel-'+name);if(panel)panel.classList.remove('hidden');if(name==='orders')loadCustomerOrders();if(name==='buyAgain')renderBuyAgain();if(name==='myList')loadCustomerProducts();if(name==='stamps'){} }
window.openCustomerPanel=openCustomerPanel;
document.querySelectorAll('[data-customer-panel]').forEach(b=>b.onclick=()=>openCustomerPanel(b.dataset.customerPanel));
$('openCustomerProfile').onclick=()=>{openCustomerPanel('profile');$('profileSummary').textContent=customerProfile?`${customerProfile.name} · ${customerProfile.mobile} · ${customerProfile.address||customerProfile.village||''}`:'';renderProfileOrders();};
$('saveCustomerAddress').onclick=async()=>{clear('profileMsg');const name=$('profileName').value.trim(),address=$('profileAddress').value.trim();if(!name||!address)return msg('profileMsg','Enter your name and address before saving.');$('saveCustomerAddress').disabled=true;try{const r=await api('/api/customer/profile','PATCH',{name,address});customerProfile={...customerProfile,...r.profile};$('welcome').textContent=`${customerProfile.name} · ${customerProfile.mobile} · ${customerProfile.address}`;$('profileSummary').textContent=`${customerProfile.name} · ${customerProfile.mobile} · ${customerProfile.address}`;msg('profileMsg','Your profile and address have been saved.')}catch(e){msg('profileMsg',e.message)}finally{$('saveCustomerAddress').disabled=false}};

$('showPinReset').onclick=()=>$('pinResetFields').classList.toggle('hidden');
$('submitPinReset').onclick=async()=>{clear('pinResetMsg');const mobile=$('resetMobile').value.trim(),code=$('resetCode').value.trim(),newPin=$('newPin').value;if(!/^\d{10}$/.test(mobile)||!/^\d{6}$/.test(code)||!/^\d{6}$/.test(newPin))return msg('pinResetMsg','Enter valid mobile, reset code and new 6-digit PIN.');try{await pinApi('/api/customer/reset-pin',{mobile,code,newPin});msg('pinResetMsg','PIN reset successful. Please login with your new PIN.');$('phone').value=mobile;$('customerPassword').value='';$('resetCode').value='';$('newPin').value=''}catch(e){msg('pinResetMsg',e.message)}};
$('issuePinReset').onclick=async()=>{clear('adminPinResetMsg');try{const r=await api('/api/admin/issue-reset','POST',{customerUid:selected.id});$('adminPinResetMsg').textContent=`ONE-TIME CODE: ${r.code} — valid for 10 minutes. Share privately.`;$('adminPinResetMsg').classList.remove('hidden')}catch(e){msg('adminPinResetMsg',e.message)}};
$('loginBtn').onclick=async()=>{
  clear('adminMsg');
  const email=$('email').value.trim(),password=$('password').value;
  if(!email||!password)return msg('adminMsg','Enter both Admin email and password.');
  const button=$('loginBtn');button.disabled=true;button.textContent='Checking login…';
  try{await signInWithEmailAndPassword(auth,email,password);}
  catch(e){
    const messages={
      'auth/invalid-credential':'Email or password is incorrect. Please check and try again.',
      'auth/user-not-found':'This Admin email is not registered in Firebase Authentication.',
      'auth/wrong-password':'Incorrect Admin password.',
      'auth/too-many-requests':'Too many attempts. Please wait a few minutes and try again.',
      'auth/network-request-failed':'Network error. Check your internet connection and try again.',
      'auth/operation-not-allowed':'Email/Password sign-in is disabled in Firebase Authentication.'
    };
    msg('adminMsg',messages[e.code]||('Admin login failed: '+(e.message||e.code||'Unknown error')));
  }finally{button.disabled=false;button.textContent='Admin Login';}
};
window.customerLogoutNow=async()=>{try{try{sessionStorage.removeItem('tanmayi_customer_active_page')}catch(_){}await signOut(auth);$('customerPassword').value='';show(adminRoute?'adminLogin':'publicStorefront');}catch(e){msg('phoneMsg','Could not logout. Please check your internet and try again.')}};
$('logout').onclick=()=>signOut(auth);
$('customerLogout').onclick=()=>window.customerLogoutNow();
$('showRegister').onclick=()=>$('registerFields').classList.toggle('hidden');
$('customerSignIn').onclick=async()=>{
  clear('phoneMsg');
  const m=$('phone').value.trim(),p=$('customerPassword').value;
  if(!/^\d{10}$/.test(m)||!/^\d{6}$/.test(p))return msg('phoneMsg','Enter valid 10-digit mobile and 6-digit PIN.');
  const button=$('customerSignIn');button.disabled=true;button.textContent='Checking PIN…';
  try{
    // Clear any previous persisted account before validating the newly entered PIN.
    if(auth.currentUser)await signOut(auth);
    await signInWithEmailAndPassword(auth,customerEmail(m),p);
  }catch(e){
    if(auth.currentUser)await signOut(auth).catch(()=>{});
    const message=e.code==='auth/invalid-credential'||e.code==='auth/wrong-password'||e.code==='auth/user-not-found'
      ?'Mobile number or 6-digit PIN is incorrect. Please try again.'
      :e.code==='auth/too-many-requests'?'Too many attempts. Please wait and try again.'
      :e.message||'Customer login failed.';
    show('customerLogin');msg('phoneMsg',message);
  }finally{button.disabled=false;button.textContent='Customer Login';}
};
$('register').onclick=async()=>{clear('phoneMsg');const mobile=$('phone').value.trim(),password=$('customerPassword').value,name=$('name').value.trim(),village=$('village').value.trim();if(!/^\d{10}$/.test(mobile)||!/^\d{6}$/.test(password)||!name||!village)return msg('phoneMsg','Enter name, village, valid mobile and 6-digit PIN.');try{await createUserWithEmailAndPassword(auth,customerEmail(mobile),password);await api('/api/customer/register','POST',{name,mobile,village});await loadCustomer();loadCustomerProducts()}catch(e){msg('phoneMsg',e.code==='auth/email-already-in-use'?'This mobile number is already registered. Please login.':e.message)}};
if(!adminRoute)loadPublicProducts();
onAuthStateChanged(auth,async u=>{
  apiAuthUser=u||null;
  $('authBootMessage')?.classList.add('hidden');
  document.documentElement.classList.add('tanmayi-auth-ready');
  if(!u){pendingOfferCart=[];cartOwnerMobile='';cartRestoredForMobile='';renderFloatingCart();show(adminRoute?'adminLogin':'publicStorefront');return;}
  if(!adminRoute){
    // Customer login must not depend on read access to the admins collection.
    // Authenticate the customer directly through their own customer API.
    try{
      await loadCustomer();
      show('customerView');
      // Start store settings in the background so they do not delay the product catalogue.
      if(window.refreshTanmayiStoreSettings) window.refreshTanmayiStoreSettings().catch(error=>console.warn('Store settings loaded later:',error));
      loadCustomerProducts();
    }catch(e){
      show('customerLogin');
      msg('phoneMsg',e.message||'Customer account could not be loaded. Please try again.');
    }
    return;
  }
  try{
    const a=await getDoc(doc(db,'admins',u.uid));
    if(a.exists()&&a.data().role==='admin'&&a.data().active===true){
      show('adminApp');$('adminEmail').textContent=u.email||'';
      await Promise.all([loadCustomers(),loadAdminProducts(),loadAdminPaymentSettings(),loadAdminOfferOrders(),loadRewardEligible()]);
    }else{
      await signOut(auth);show('adminLogin');
      msg('adminMsg','Email and password were accepted, but this Firebase account is NOT enabled as an active shop admin. The Firestore admins/'+u.uid+' document must exist with role: "admin" and active: true.');
    }
  }catch(e){
    show('adminLogin');
    msg('adminMsg','Admin verification failed: '+(e.message||'Could not read the admin permission record. Check Firestore access and network.'));
  }
});
async function loadCustomer(){const h=await api('/api/customer/home');show('customerView');restorePendingOfferCart(h.profile.mobile);customerProfile={...h.profile,address:h.profile.address||h.profile.village||''};$('welcome').textContent=`${h.profile.name} · ${h.profile.mobile} · ${h.profile.address||h.profile.village}`;$('profileName').value=h.profile.name||'';$('profileMobile').value=h.profile.mobile||'';$('profileAddress').value=customerProfile.address||'';$('myStamps').textContent=h.stamps;$('dashboardStamps').textContent=`${h.stamps} / 10`;$('myBills').textContent=h.latestBill?money(h.latestBillAmount):'No bills yet';$('myGifts').textContent=h.giftsRedeemed;pendingId=h.pendingRedemption?.id||null;$('approvedPointsInfo').classList.add('hidden');document.querySelector('input[name="rewardChoice"][value="gift"]').checked=true;if(h.pendingRedemption){$('customerPending').classList.remove('hidden');const pts=Number(h.pendingRedemption.approvedPoints||0);$('pendingText').textContent=pts>0?'You are eligible. Choose a free gift or approved points (1 point = ₹1).':'You are eligible for a free gift.';$('rewardChoices').classList.toggle('hidden',pts<=0);$('rewardChoiceLabel').classList.toggle('hidden',pts<=0);$('pointsChoiceLabel').classList.toggle('hidden',pts<=0);$('approvedPointsValue').textContent=pts.toLocaleString('en-IN');$('approvedPointsRupees').textContent='Redeem value: '+money(pts)}else $('customerPending').classList.add('hidden');try{const hist=await api('/api/customer/history');$('customerHistory').innerHTML=hist.history.map(x=>`<tr><td>${date(x.date)}</td><td><strong>${moneyPrice(x.amount)}</strong></td></tr>`).join('')||'<tr><td colspan="2">No bill history yet</td></tr>'}catch(e){$('customerHistory').innerHTML='<tr><td colspan="2">Bill history is temporarily unavailable.</td></tr>'}await loadCustomerOrders();if(window.refreshTanmayiStoreSettings)await window.refreshTanmayiStoreSettings();if(window.showTanmayiInstallPopup)window.showTanmayiInstallPopup(customerProfile.mobile)}
$('refreshCustomerAccount').onclick=async()=>{try{await loadCustomer();if(window.refreshTanmayiStoreSettings)await window.refreshTanmayiStoreSettings();msg('customerRedeemMsg','Account refreshed. Your latest stamps and bill history are shown.')}catch(e){msg('customerRedeemMsg',e.message)}};
document.querySelectorAll('input[name="rewardChoice"]').forEach(el=>el.addEventListener('change',()=>{$('approvedPointsInfo').classList.toggle('hidden',el.value!=='points'||!el.checked)}));
$('customerTaken').onclick=async()=>{if(!pendingId)return;clear('customerRedeemMsg');$('customerTaken').disabled=true;try{const choice=document.querySelector('input[name="rewardChoice"]:checked')?.value||'gift';await api('/api/customer/redeem-taken','POST',{redemptionId:pendingId,choice});msg('customerRedeemMsg','Redemption completed. Stamps and current cycle reset successfully.');await loadCustomer()}catch(e){msg('customerRedeemMsg',e.message)}finally{$('customerTaken').disabled=false}};
async function loadRewardEligible(){
  try{
    const r=await api('/api/admin/reward-eligible');
    $('rewardEligibleList').innerHTML=r.customers.map(c=>`<div class="product-card">
      <strong>${esc(c.name)}</strong>
      <p>Mobile: ${esc(c.mobile)}</p>
      <p>Village: ${esc(c.village)}</p>
      <p class="price-offer">${Number(c.stamps)} / 10 Stamps</p>
      <p>${c.pendingRedemption?'<span class="tag">Reward options already prepared</span>':'<span class="tag">Eligible for reward</span>'}</p>
      <button class="gold" data-manage-reward="${esc(c.id)}">Manage Reward</button>
    </div>`).join('')||'<p class="muted">No customers have reached 10 stamps yet.</p>';
    document.querySelectorAll('[data-manage-reward]').forEach(b=>b.onclick=()=>openCustomer(b.dataset.manageReward));
  }catch(e){$('rewardEligibleList').textContent=e.message||'Could not load reward-eligible customers.'}
}
$('refreshRewardEligible').onclick=loadRewardEligible;
async function loadCustomers(){const [r,x]=await Promise.all([api('/api/admin/customers'),api('/api/admin/summary')]);customers=r.customers;render();$('customerCount').textContent=x.customerCount;$('stampCount').textContent=x.stampCount;$('giftCount').textContent=x.giftCount}
function render(){const t=$('search').value.trim().toLowerCase(),list=customers.filter(c=>(c.name||'').toLowerCase().includes(t)||(c.mobile||'').includes(t));$('rows').innerHTML=list.map(c=>`<tr><td>${esc(c.name)}<br><small>${esc(c.id)}</small></td><td>${esc(c.mobile)}</td><td>${esc(c.village)}</td><td>${date(c.createdAt)}</td><td>${Number(c.stamps||0)} / 10</td><td><button data-id="${esc(c.id)}">Open</button></td></tr>`).join('')||'<tr><td colspan="6">No customers found</td></tr>';document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>openCustomer(b.dataset.id))}
$('search').oninput=render;
async function openCustomer(id){selected=customers.find(c=>c.id===id);if(!selected)return;$('detail').classList.remove('hidden');$('detailName').textContent=selected.name||'Customer';$('detailInfo').textContent=`ID: ${id} · ${selected.mobile||''} · ${selected.village||''}`;await refresh()}
$('close').onclick=()=>{$('detail').classList.add('hidden');selected=null};
async function refresh(){if(!selected)return;const d=await api('/api/admin/customer/'+encodeURIComponent(selected.id));$('detailStamps').textContent=d.stamps;$('detailCycleTotal').textContent=money(d.cycleBillTotal);$('detailLifetimeTotal').textContent=money(d.lifetimeBillTotal);$('detailGiftCount').textContent=d.redemptions.filter(x=>x.status==='taken').length;$('billRows').innerHTML=d.bills.map(b=>`<tr><td>${date(b.date)}</td><td>${money(b.amount)}</td><td>+${b.stampsAdded}</td><td>${esc(b.source==='shop-offer'?'Shop offer · '+(b.productName||'Product'):'Admin bill')}</td></tr>`).join('')||'<tr><td colspan="4">No bills yet</td></tr>';$('redRows').innerHTML=d.redemptions.map(r=>`<tr><td>${date(r.date)}</td><td>${esc(r.type)} · ${esc(r.status)}</td><td>${Number(r.approvedPoints||0)}</td></tr>`).join('')||'<tr><td colspan="3">No redemptions yet</td></tr>';customers=customers.map(c=>c.id===selected.id?{...c,stamps:d.stamps}:c);render()}
$('saveBill').onclick=async()=>{clear('billMsg');const amount=Number($('billAmount').value);if(!selected||!Number.isFinite(amount)||amount<=0)return msg('billMsg','Enter a valid bill amount.');try{const r=await api('/api/admin/add-bill','POST',{customerUid:selected.id,amount});$('billAmount').value='';msg('billMsg',`${r.stampsAdded} stamp(s) added.`);await refresh();await loadCustomers();await loadRewardEligible()}catch(e){msg('billMsg',e.message)}};
$('redeem').onclick=async()=>{clear('redeemMsg');const points=Number($('approvedPoints').value);if(!selected||!Number.isInteger(points)||points<0)return msg('redeemMsg','Enter 0 or a whole-number points amount.');try{const r=await api('/api/admin/create-redemption','POST',{customerUid:selected.id,approvedPoints:points});msg('redeemMsg',`Approval created. Customer can choose ${r.type==='gift'?'the gift':'gift or approved points'}. No reset until customer confirms collection.`);await refresh();await loadRewardEligible()}catch(e){msg('redeemMsg',e.message)}};
$('makeQR').onclick=()=>{const url=location.origin+location.pathname;$('qrCode').innerHTML='';new QRCode($('qrCode'),{text:url,width:220,height:220});$('qrUrl').textContent=url;$('qrWrap').classList.remove('hidden')};
$('downloadQR').onclick=()=>{const img=$('qrCode').querySelector('img'),canvas=$('qrCode').querySelector('canvas'),url=img?.src||canvas?.toDataURL('image/png');if(url){const a=document.createElement('a');a.href=url;a.download='tanmayi-customer-qr.png';a.click()}};

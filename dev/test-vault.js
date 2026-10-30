// End-to-end test of v0.30 in headless Chromium with a mock Google Drive + mock Google sign-in.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = '/home/claude/work/out';
const SHOTS = '/home/claude/work/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const ORIGIN = 'https://jdl2025.github.io/red-folder/';
const FOLDER = '1R33mYIc3GJ8NurkS4PIcT5zNUG8j2ALZ';

// ── Mock Drive state ──
const drive = { files: {}, seq: 0, expireNext: false, user: 'james', requests: [] };
function newId() { drive.seq++; return 'id' + drive.seq + 'x' + Math.random().toString(36).slice(2, 8); }
function addFile(f) { const id = f.id || newId(); drive.files[id] = Object.assign({ id, parents: [FOLDER], trashed: false, properties: {}, createdTime: new Date(Date.now() + drive.seq).toISOString(), modifiedTime: new Date().toISOString(), owner: drive.user, content: Buffer.alloc(0) }, f, { id }); return drive.files[id]; }
function evalQ(q, f) {
  let expr = q
    .replace(/properties has \{ key='([^']+)' and value='([^']+)' \}/g, (m, k, v) => '((f.properties||{})[' + JSON.stringify(k) + ']===' + JSON.stringify(v) + ')')
    .replace(/'([^']+)' in parents/g, (m, p) => '(f.parents.includes(' + JSON.stringify(p) + '))')
    .replace(/trashed=false/g, '(!f.trashed)')
    .replace(/name = '([^']+)'/g, (m, n) => '(f.name===' + JSON.stringify(n) + ')')
    .replace(/ and /g, ' && ').replace(/ or /g, ' || ');
  return Function('f', 'return ' + expr)(f);
}
function publicView(f) { return { id: f.id, name: f.name, mimeType: f.mimeType, description: f.description, properties: f.properties, createdTime: f.createdTime, modifiedTime: f.modifiedTime, size: String(f.content.length), capabilities: { canTrash: f.owner === drive.user } }; }
function parseMultipart(buf, ctype) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
  const b = '--' + (boundary[1] || boundary[2]);
  const parts = [];
  let idx = buf.indexOf(b);
  while (idx !== -1) {
    const start = idx + b.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(b, start);
    const part = buf.slice(start + 2, next - 2); // skip \r\n ... \r\n
    const sep = part.indexOf('\r\n\r\n');
    parts.push({ headers: part.slice(0, sep).toString(), body: part.slice(sep + 4) });
    idx = next;
  }
  return { meta: JSON.parse(parts[0].body.toString() || '{}'), content: parts[1] ? parts[1].body : null };
}
async function handleDrive(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  drive.requests.push(method + ' ' + url.pathname);
  const auth = req.headers()['authorization'] || '';
  if (!auth.startsWith('Bearer tok')) return route.fulfill({ status: 401, body: 'no auth' });
  if (drive.expireNext) { drive.expireNext = false; return route.fulfill({ status: 401, body: 'expired' }); }
  const json = (obj, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(obj), headers: { 'access-control-allow-origin': '*' } });
  let m;
  if (method === 'GET' && url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q');
    let list = Object.values(drive.files).filter(f => evalQ(q, f));
    const ob = url.searchParams.get('orderBy') || '';
    if (ob.startsWith('createdTime')) list.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    if (ob.startsWith('modifiedTime')) list.sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
    if (ob.endsWith('desc')) list.reverse();
    const size = parseInt(url.searchParams.get('pageSize') || '100', 10);
    const pt = parseInt(url.searchParams.get('pageToken') || '0', 10);
    const page = list.slice(pt, pt + Math.min(size, 3)); // force pagination with tiny pages
    const out = { files: page.map(publicView) };
    if (pt + page.length < list.length && page.length > 0) out.nextPageToken = String(pt + page.length);
    return json(out);
  }
  if (method === 'GET' && (m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)) && url.searchParams.get('alt') === 'media') {
    const f = drive.files[m[1]];
    if (!f) return json({ error: 'nf' }, 404);
    return route.fulfill({ status: 200, body: f.content, contentType: 'application/octet-stream' });
  }
  if (method === 'PATCH' && (m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname))) {
    const f = drive.files[m[1]];
    if (!f) return json({ error: 'nf' }, 404);
    const body = JSON.parse(req.postData() || '{}');
    if (body.trashed && f.owner !== drive.user) return json({ error: 'insufficientFilePermissions' }, 403);
    Object.assign(f, body, { modifiedTime: new Date().toISOString() });
    return json({ id: f.id });
  }
  if (method === 'DELETE' && (m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname))) {
    const f = drive.files[m[1]];
    if (!f) return json({ error: 'nf' }, 404);
    if (f.owner !== drive.user) return json({ error: 'insufficientFilePermissions' }, 403);
    delete drive.files[m[1]];
    drive.deleted = (drive.deleted || 0) + 1;
    return route.fulfill({ status: 204, body: '' });
  }
  if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
    const mp = parseMultipart(req.postDataBuffer(), req.headers()['content-type']);
    const f = addFile(Object.assign({}, mp.meta, { content: mp.content, owner: drive.user }));
    return json({ id: f.id, name: f.name });
  }
  if (method === 'PATCH' && (m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname))) {
    const f = drive.files[m[1]];
    if (!f) return json({ error: 'nf' }, 404);
    const mp = parseMultipart(req.postDataBuffer(), req.headers()['content-type']);
    Object.assign(f, mp.meta, { content: mp.content || f.content, modifiedTime: new Date().toISOString() });
    return json({ id: f.id });
  }
  return json({ error: 'unhandled ' + method + ' ' + url.pathname }, 400);
}

const FAKE_GIS = "window.__tokenRequests=0;window.google={accounts:{oauth2:{initTokenClient:function(cfg){return {requestAccessToken:function(o){window.__tokenRequests++;var n=window.__tokenRequests;setTimeout(function(){if(window.__closePopup){cfg.error_callback({type:'popup_closed'});return;}cfg.callback({access_token:'tok-'+n,expires_in:3600,scope:window.__denyScope?'email':'https://www.googleapis.com/auth/drive'});},20);}};},hasGrantedAllScopes:function(r,s){return (r.scope||'').indexOf(s)!==-1;},revoke:function(){}}}};";

let failures = 0, passes = 0;
function check(cond, label) { if (cond) { passes++; console.log('  ✓ ' + label); } else { failures++; console.log('  ✗ FAIL: ' + label); } }

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [], cspBlocks = [], dialogs = [];
  page.on('console', m => {
    const t = m.text();
    if (t.indexOf('Blocked by Content-Security-Policy') !== -1 || t.indexOf('Content Security Policy') !== -1) cspBlocks.push(t);
    if (m.type() === 'error' && t.indexOf('fonts.g') === -1 && t.indexOf('Failed to load resource') === -1 && t.indexOf('Drive error') === -1 && t.indexOf('Unreadable item') === -1 && t.indexOf('Incorrect passphrase') === -1 && !/^(Error|JSHandle)/.test(t)) consoleErrors.push(t);
  });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR ' + e.message));
  page.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message()); d.accept(); });

  await context.route('**/*', async route => {
    const u = route.request().url();
    if (u === ORIGIN || u === ORIGIN + 'index.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(OUT, 'index.html')) });
    if (u === ORIGIN + 'offline.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(OUT, 'offline.html')) });
    if (u === ORIGIN + 'jszip.min.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(OUT, 'jszip.min.js')) });
    if (u.startsWith('https://accounts.google.com/gsi/client')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_GIS });
    if (u.startsWith('https://www.googleapis.com/')) return handleDrive(route);
    return route.abort();
  });

  const items = () => Object.values(drive.files).filter(f => f.properties.rf === 'item' && !f.trashed);
  const fileNames = () => page.$$eval('#fileList .file-name', els => els.map(e => e.textContent));
  async function login(mode, pass) {
    await page.click(mode === 'owner' ? '#modeOwner' : '#modeFamily');
    await page.fill('#passphrase', pass);
    await page.click('#loginBtn');
    await page.waitForFunction(() => !document.getElementById('loginBtn').disabled || document.getElementById('app').classList.contains('visible'), null, { timeout: 20000 });
    await page.waitForTimeout(300);
  }
  async function logout() { await page.evaluate(() => doLogout()); await page.waitForTimeout(100); }
  async function waitList() { await page.waitForFunction(() => !document.querySelector('#fileList .list-empty') || document.querySelector('#fileList .list-empty').textContent.indexOf('Loading') === -1, null, { timeout: 15000 }); await page.waitForTimeout(150); }

  // Pre-existing junk: an old v0.19 test file (no tags)
  addFile({ name: 'old test.pdf.vaultenc', description: JSON.stringify({ originalName: 'old test.pdf' }), content: Buffer.from('oldformat') });

  console.log('\n1. Page load');
  await page.goto(ORIGIN);
  await page.waitForTimeout(400);
  check((await page.textContent('#versionTag')).indexOf('v0.30') !== -1, 'version tag shows v0.30');
  check(await page.isVisible('#loginScreen'), 'login screen visible');
  check(await page.isHidden('#modeNote'), 'no extra note while "Login as James" is selected');
  await page.click('#modeFamily');
  check(await page.isVisible('#modeNote') && (await page.textContent('#modeNote')).indexOf('same passphrase') !== -1, 'choosing "Login as Sarah" shows the same-passphrase / Login as James note');
  await page.click('#modeOwner');
  check((await page.$$('input[type=password]')).length === 0, 'no password-type boxes on the page (browsers won\'t offer to save)');
  check((await page.$eval('#passphrase', e => getComputedStyle(e).webkitTextSecurity)) === 'disc', 'passphrase box still shows dots');

  console.log('\n2. Empty vault');
  await login('family', 'anything at all here');
  check((await page.textContent('#loginError')).indexOf("hasn't been set up yet") !== -1, 'Sarah on an empty vault is told James must set it up');
  await page.fill('#passphrase', 'whatever goes here');
  await page.click('#modeOwner');
  await page.click('#loginBtn');
  await page.waitForSelector('#setupView', { state: 'visible' });
  check(true, 'James on an empty vault sees first-time setup');
  await page.fill('#setupPass1', 'too short'); await page.fill('#setupPass2', 'too short'); await page.click('#setupCreate');
  await page.waitForFunction(() => document.getElementById('setupError').textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  check((await page.textContent('#setupError')).indexOf('at least 16') !== -1, 'short passphrase rejected');
  await page.fill('#setupPass1', 'Sam’s  Test Passphrase 42'); await page.fill('#setupPass2', 'different passphrase 42'); await page.click('#setupCreate');
  check((await page.textContent('#setupError')).indexOf("don't match") !== -1, 'mismatch rejected');
  await page.fill('#setupPass2', 'Sam’s  Test Passphrase 42'); await page.click('#setupCreate');
  check((await page.textContent('#setupError')).indexOf('written the passphrase down') !== -1, 'acknowledgement required');
  await page.check('#setupAck');
  await page.click('#setupCreate');
  await page.waitForSelector('#app.visible', { timeout: 20000 });
  check(true, 'vault created and opened');
  const keyFile = Object.values(drive.files).find(f => f.properties.rf === 'vaultkey');
  check(!!keyFile && keyFile.name === 'red-folder-vault-key.json', 'vault key file saved to Drive with the expected name');
  const keyDoc = JSON.parse(keyFile.content.toString());
  check(keyDoc.format === 'larson-red-folder-vault-key' && keyDoc.slots[0].iterations === 600000 && !!keyDoc.slots[0].wrappedKey, 'vault key file format, 600k iterations');
  check(keyFile.content.toString().toLowerCase().indexOf('passphrase 42') === -1, 'passphrase does not appear in the key file');
  check(await page.isVisible('.rf-overlay'), 'backup reminder shown after creation');
  check((await page.textContent('.rf-overlay')).indexOf('USB copy') !== -1, 'creation notice points to the USB copy');
  await page.click('.rf-overlay .btn.gold');
  await page.click('#navSettings');
  const dlKey = page.waitForEvent('download');
  await page.click('#downloadKeyBtn');
  const keyDownload = await dlKey;
  check(keyDownload.suggestedFilename() === 'red-folder-vault-key.json', 'vault key backup downloads');
  fs.copyFileSync(await keyDownload.path(), '/home/claude/work/shots/key-backup.json');

  console.log('\n3. Upload (apostrophe + hostile file names)');
  await page.click('#navFamily');
  await waitList();
  check((await fileNames()).length === 0 && (await page.textContent('#fileList')).indexOf('Nothing here yet') !== -1, 'old untagged v0.19 file is ignored; empty categories shown');
  const famHeads = await page.$$eval('#fileList .cat-name', els => els.map(e => e.textContent));
  check(famHeads.join('|') === 'Identity|Insurance|Home & Cars|Medical|Other', 'Family Vault categories in order: Identity, Insurance, Home & Cars, Medical, Other');
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nSECRET-PDF-CONTENT');
  const xssName = '<img src=x onerror=alert(1)>.png';
  await page.setInputFiles('#fileInput', [
    { name: "Sarah's Passport.pdf", mimeType: 'application/pdf', buffer: pdfBytes },
    { name: xssName, mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello SECRET-TEXT') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('second notes file') }
  ]);
  await page.waitForSelector('.rf-overlay .cat-choice', { timeout: 10000 });
  check((await page.textContent('.rf-overlay')).indexOf('Where should these 4 files go?') !== -1, 'upload asks which category');
  await page.click('.rf-overlay .cat-choice:has-text("Identity")');
  await page.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 4, null, { timeout: 20000 });
  check((await page.$$('#fileList [data-category="identity"] .file-row')).length === 4, 'documents are grouped under their category');
  check((await page.textContent('#fileList .file-row .file-date')).indexOf('📅 Uploaded ') === 0 && (await page.textContent('#fileList .file-row .file-date')).indexOf('· today') !== -1, 'each document shows "📅 Uploaded <date> · today"');
  const names = await fileNames();
  check(names.includes("Sarah's Passport.pdf") && names.includes(xssName), 'apostrophe and HTML-like names display as plain text');
  check(!dialogs.some(d => d.startsWith('alert')), 'no script ran from the hostile file name');
  const stored = items();
  check(stored.length === 4 && stored.every(f => /^vault-item-[0-9a-f]{16}$/.test(f.name)), 'Drive file names are random (no real names)');
  check(stored.every(f => f.description.startsWith('rf1:') && f.description.indexOf('Passport') === -1), 'Drive descriptions are encrypted');
  check(stored.every(f => f.content.slice(0, 4).equals(Buffer.from([0x52, 0x46, 0x56, 1]))), 'contents carry the RFV v1 header');
  check(!stored.some(f => f.content.toString('latin1').indexOf('SECRET') !== -1), 'contents are encrypted');
  check(drive.requests.filter(r => r.indexOf('/permissions') !== -1).length === 0, 'no per-file sharing calls (Sarah email removed)');
  check((await page.textContent('#statusDocs')) === '4', 'document count is real');

  console.log('\n4. View + notes');
  const rowFor = (n) => page.locator('#fileList .file-row', { has: page.locator('.file-name', { hasText: n }) }).first();
  await rowFor("Sarah's Passport.pdf").locator('button', { hasText: 'View' }).click();
  await page.waitForSelector('.viewer-body iframe', { timeout: 10000 });
  check(true, "apostrophe file opens in the viewer (the old bug)");
  check(await page.isVisible('text=Open PDF in a New Tab'), 'PDF viewer offers open-in-new-tab (iPhone)');
  await page.waitForSelector('text=No note yet.');
  await page.click('text=+ Add Note');
  await page.fill('.note-textarea', 'Expires 2031 — renew early.');
  await page.click('text=Save Note');
  await page.waitForSelector('.note-text:has-text("Expires 2031")');
  const noteFile = Object.values(drive.files).find(f => f.properties.rf === 'note' && !f.trashed);
  check(!!noteFile && noteFile.content.toString('latin1').indexOf('Expires') === -1, 'note saved encrypted');
  const urlsBefore = await page.evaluate(() => objectUrls.size);
  await page.keyboard.press('Escape');
  check((await page.evaluate(() => objectUrls.size)) < urlsBefore, 'closing the viewer releases the decrypted copy');
  await rowFor("Sarah's Passport.pdf").locator('button', { hasText: 'View' }).click();
  await page.waitForSelector('.note-text:has-text("Expires 2031")');
  check(true, 'note reloads on reopen');
  const dl1 = page.waitForEvent('download');
  await page.click('text=Download Unencrypted Copy');
  const d1 = await dl1;
  check(fs.readFileSync(await d1.path()).equals(pdfBytes), 'download decrypts to the exact original bytes');
  await page.click('.viewer-close');

  console.log('\n5. Edit (rename + move) / Replace');
  await rowFor("Sarah's Passport.pdf").locator('button', { hasText: 'Edit' }).click();
  await page.fill('.rf-overlay input', "Sarah's New Passport");
  await page.click('.rf-overlay .cat-choice:has-text("Insurance")');
  await page.click('.rf-overlay button:has-text("Save")');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.file-name')).some(e => e.textContent === "Sarah's New Passport.pdf"));
  check(true, 'rename keeps the extension');
  check((await page.$$eval('#fileList [data-category="insurance"] .file-name', els => els.map(e => e.textContent))).includes("Sarah's New Passport.pdf"), 'Edit moves a document to another category');
  const notesRow = rowFor('notes.txt');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), notesRow.locator('button', { hasText: 'Replace' }).click()]);
  await chooser.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0aREPLACED', 'hex') });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.file-name')).some(e => e.textContent === 'notes.png'), null, { timeout: 10000 });
  check(true, 'replace with a different type updates the extension');
  check((await rowFor('notes.png').locator('.file-date').textContent()).indexOf('📅 Updated ') === 0, 'after Replace, the date reads "Updated"');
  await page.evaluate(() => {
    const it = vaultItems.find(i => i.meta.name === 'notes.png');
    const old = new Date(Date.now() - 800 * 86400000).toISOString();
    it.meta.contentAt = old; it.meta.uploadedAt = old; renderFileList();
  });
  const oldRow = rowFor('notes.png').locator('.file-date');
  check((await oldRow.getAttribute('class')).indexOf('old') !== -1 && (await oldRow.textContent()).indexOf('2 years ago') !== -1, 'documents over a year old are highlighted ("2 years ago — may need updating")');
  await page.screenshot({ path: SHOTS + '/dates.png', clip: { x: 272, y: 0, width: 1008, height: 900 } });
  await page.evaluate(() => loadFileList());
  await waitList();

  console.log('\n6. Google sign-in expiry mid-session');
  const tokensBefore = await page.evaluate(() => window.__tokenRequests);
  drive.expireNext = true;
  await page.click('.topbar-btn:has-text("Refresh")');
  await page.waitForSelector('text=Please reconnect to Google', { timeout: 10000 });
  check(true, 'expired sign-in pauses with a reconnect prompt (instead of "No documents yet")');
  await page.click('text=Reconnect Google Drive');
  await page.waitForFunction(() => !document.querySelector('.rf-overlay'), null, { timeout: 10000 });
  await waitList();
  check((await page.evaluate(() => window.__tokenRequests)) === tokensBefore + 1 && (await fileNames()).length === 4, 'after reconnecting the list loads normally');

  console.log('\n7. Remove goes to trash (with its note)');
  await rowFor("Sarah's New Passport.pdf").locator('button', { hasText: 'Remove' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 3, null, { timeout: 10000 });
  const trashed = Object.values(drive.files).filter(f => f.trashed && (f.properties.rf === 'item' || f.properties.rf === 'note'));
  check(trashed.length === 2, 'item and its note moved to trash (not permanently deleted)');
  check(dialogs.some(d => d.indexOf('recovered for 30 days') !== -1), 'confirmation explains 30-day trash');

  console.log('\n8. Export ZIP');
  await page.click('#navSettings');
  await page.click('#exportBtnSettings');
  const dlZip = page.waitForEvent('download', { timeout: 20000 });
  await page.click('text=I Understand — Export');
  const zipDl = await dlZip;
  const zipPath = '/home/claude/work/shots/export.zip';
  fs.copyFileSync(await zipDl.path(), zipPath);
  const listing = execSync('python3 -I -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);[print(n) for n in z.namelist()]" ' + zipPath).toString();
  check(listing.indexOf('notes.txt') !== -1 && listing.indexOf('notes.png') !== -1 && listing.indexOf('README.txt') !== -1, 'ZIP contains decrypted files + README');
  check(listing.indexOf(xssName) !== -1, 'ZIP keeps original names');
  check(!cspBlocks.some(b => b.indexOf('jszip') !== -1), 'JSZip loads under the security policy with integrity check');


  console.log('\n8b. USB copy (offline backup)');
  // add a note so the USB copy carries one
  await page.click('#navFamily'); await waitList();
  await rowFor('notes.txt').locator('button', { hasText: 'View' }).click();
  await page.waitForSelector('text=No note yet.');
  await page.click('text=+ Add Note');
  await page.fill('.note-textarea', 'Note travels to the USB.');
  await page.click('text=Save Note');
  await page.waitForSelector('.note-text:has-text("travels")');
  const notesTxtContent = (await page.textContent('.viewer-body pre'));
  await page.click('.viewer-close');
  await page.click('#navHome');
  await page.waitForFunction(() => document.getElementById('statusUsb').textContent === 'Not made yet', null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent('#statusUsb')) === 'Not made yet', 'home shows "USB Copy: Not made yet"');
  check(await page.isVisible('#homeUsbNotice'), 'home shows a USB reminder banner');
  await page.click('#signOutLink');
  await page.waitForSelector('text=Before You Sign Out', { timeout: 10000 });
  check(true, 'signing out with no USB copy shows the reminder');
  await page.click('.rf-overlay button:has-text("Stay Signed In")');
  await page.click('#navSettings');
  const dlUsb = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#usbCopyBtn');
  const usbDl = await dlUsb;
  check(usbDl.suggestedFilename() === 'Larson Family Vault.html', 'USB copy downloads as "Larson Family Vault.html"');
  const usbPath = '/home/claude/work/shots/Larson Family Vault.html';
  fs.copyFileSync(await usbDl.path(), usbPath);
  const usbHtml = fs.readFileSync(usbPath, 'utf8');
  check(usbHtml.indexOf('Passport') === -1 && usbHtml.indexOf('notes.txt') === -1 && usbHtml.indexOf('SECRET') === -1 && usbHtml.indexOf('travels') === -1, 'USB file holds no readable names, contents or notes');
  await page.waitForSelector('text=Now put it on the USB drive');
  check((await page.textContent('.rf-overlay')).indexOf('delete the old') !== -1, 'step-by-step USB instructions shown');
  await page.click(".rf-overlay button:has-text(\"Done — It's on the USB\")");
  await page.waitForFunction(() => document.getElementById('statusUsb').textContent === 'Up to date ✓', null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent('#statusUsb')) === 'Up to date ✓', 'status becomes "Up to date"');
  await page.click('#signOutLink');
  await page.waitForSelector('#loginScreen', { state: 'visible', timeout: 10000 });
  check((await page.textContent('#loginStatus')).indexOf('USB copy is up to date') !== -1, 'up-to-date sign-out goes straight through with a confirmation');

  // Open the USB file from disk, with ALL network blocked
  async function openOffline(disableWebCrypto) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const netHits = [];
    await ctx.route('**/*', r => { const u = r.request().url(); if (!u.startsWith('file:') && !u.startsWith('blob:') && !u.startsWith('data:')) { netHits.push(u); return r.abort(); } return r.continue(); });
    if (disableWebCrypto) await ctx.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'subtle', { get() { return undefined; } }); });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('dialog', d => d.accept());
    await p.goto('file://' + usbPath);
    return { ctx, p, netHits, errs };
  }
  let off = await openOffline(false);
  check((await off.p.textContent('#madeLine')).indexOf('made') !== -1, 'offline copy opens from the USB with no internet');
  check((await off.p.$eval('#passphrase', e => e.type + '/' + getComputedStyle(e).webkitTextSecurity)) === 'text/disc', 'offline copy: masked text box, not a password box');
  await off.p.fill('#passphrase', 'wrong passphrase entirely');
  await off.p.click('#unlockBtn');
  await off.p.waitForFunction(() => document.getElementById('loginError').textContent.length > 0, null, { timeout: 30000 });
  check((await off.p.textContent('#loginError')).indexOf('Incorrect') !== -1, 'offline: wrong passphrase refused');
  await off.p.fill('#passphrase', "SAM’S test passphrase 42");
  await off.p.click('#unlockBtn');
  await off.p.waitForSelector('#vaultScreen', { state: 'visible', timeout: 30000 });
  const offNames = await off.p.$$eval('.item-name', els => els.map(e => e.textContent));
  check(offNames.length === 3 && offNames.includes('notes.txt') && offNames.includes(xssName), 'offline: one passphrase step shows every document by its real name');
  await off.p.locator('.item', { has: off.p.locator('.item-name', { hasText: 'notes.txt' }) }).locator('button', { hasText: 'View' }).click();
  await off.p.waitForSelector('.viewer-body pre');
  check((await off.p.textContent('.viewer-body pre')) === notesTxtContent, 'offline: document opens with the exact content');
  check((await off.p.textContent('.viewer-note')).indexOf('travels') !== -1, 'offline: the note comes along');
  const dlOff = off.p.waitForEvent('download');
  await off.p.click('text=Save to This Computer');
  const offFile = await dlOff;
  check(fs.readFileSync(await offFile.path(), 'utf8') === notesTxtContent && offFile.suggestedFilename() === 'notes.txt', 'offline: Save gives the original file');
  await off.p.click('.close');
  const dlAll = off.p.waitForEvent('download', { timeout: 30000 });
  await off.p.click('#saveAllBtn');
  const allZip = await dlAll;
  const offZip = '/home/claude/work/shots/offline-all.zip';
  fs.copyFileSync(await allZip.path(), offZip);
  const offListing = execSync('python3 -I -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);[print(n) for n in z.namelist()]" "' + offZip + '"').toString();
  check(offListing.indexOf('notes.txt') !== -1 && offListing.indexOf('notes_note.txt') !== -1, 'offline: "Save Everything" ZIP works, notes included');
  await off.p.setViewportSize({ width: 375, height: 700 });
  await off.p.screenshot({ path: SHOTS + '/offline-phone-list.png', fullPage: true });
  await off.p.click('#lockBtn');
  check(await off.p.isVisible('#loginScreen'), 'offline: Lock returns to the passphrase screen');
  await off.p.setViewportSize({ width: 1280, height: 800 });
  await off.p.screenshot({ path: SHOTS + '/offline-login.png' });
  check(off.netHits.length === 0 && off.errs.length === 0, 'offline: zero network requests, zero errors');
  await off.ctx.close();
  off = await openOffline(true);
  check(await off.p.evaluate(() => !window.crypto.subtle), 'browser encryption tools disabled for this test');
  await off.p.fill('#passphrase', "sam's test passphrase 42");
  await off.p.click('#unlockBtn');
  await off.p.waitForSelector('#vaultScreen', { state: 'visible', timeout: 60000 });
  await off.p.locator('.item', { has: off.p.locator('.item-name', { hasText: 'notes.txt' }) }).locator('button', { hasText: 'View' }).click();
  await off.p.waitForSelector('.viewer-body pre');
  check((await off.p.textContent('.viewer-body pre')) === notesTxtContent, 'offline fallback: still opens when the browser lacks Web Crypto (old/odd browsers, USB quirks)');
  await off.ctx.close();

  // A change makes it stale → reminder at sign-out
  await login('owner', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  await page.click('#navFamily'); await waitList();
  await page.setInputFiles('#fileInput', [{ name: 'new after usb.txt', mimeType: 'text/plain', buffer: Buffer.from('new') }]);
  await page.click('.rf-overlay .cat-choice:has-text("Other")');
  await page.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 4, null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('statusUsb').textContent === 'Out of date', null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent('#statusUsb')) === 'Out of date', 'adding a document marks the USB copy "Out of date"');
  await page.click('#signOutLink');
  await page.waitForSelector('text=Update the USB copy', { timeout: 10000 });
  check(true, 'sign-out reminds to update the USB copy');
  await page.click('.rf-overlay button:has-text("Sign Out Without Updating")');
  await page.waitForSelector('#loginScreen', { state: 'visible' });
  await login('owner', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  // remove the extra file so later counts stay the same
  await page.click('#navFamily'); await waitList();
  await rowFor('new after usb.txt').locator('button', { hasText: 'Remove' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#fileList .file-row').length === 3, null, { timeout: 10000 });

  console.log('\n9. Sign-out clears memory');
  await logout();
  const mem = await page.evaluate(() => ({ k: masterKey, d: vaultKeyDoc, t: accessToken, n: vaultItems.length, list: document.getElementById('fileList').children.length, ov: document.querySelectorAll('.rf-overlay').length, urls: objectUrls.size }));
  check(mem.k === null && mem.d === null && mem.t === null && mem.n === 0 && mem.list === 0 && mem.ov === 0 && mem.urls === 0, 'key, token, list, modals and decrypted copies all cleared');

  console.log('\n10. Passphrase normalization + wrong passphrase');
  await login('family', 'not the passphrase at all');
  check((await page.textContent('#loginError')).indexOf('Incorrect passphrase') !== -1, 'wrong passphrase rejected');
  check(!(await page.isVisible('#app.visible')), 'app stays locked');
  await login('family', "  sam's TEST passphrase 42 ");
  await page.waitForSelector('#app.visible', { timeout: 20000 });
  check(true, 'capitals, extra spaces and straight vs curly apostrophe all normalize to the same passphrase');

  console.log('\n11. Sarah (Red Folder sealed)');
  check(await page.isHidden('#navLegacy') && await page.isHidden('#navContentGroup'), 'Red Folder, Messages, Contacts hidden from Sarah');
  check(await page.isVisible('#legacyAccessWrap'), 'Red Folder access button shown');
  const geo = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const a = r('#navFamily .dot'), b = r('#legacyAccessWrap .dot'), la = r('#navFamily .nav-label'), lb = r('#legacyAccessWrap .nav-label');
    return { sameSize: a.width === b.width && a.height === b.height, dotX: Math.abs(a.left - b.left), labelX: Math.abs(la.left - lb.left) };
  });
  check(geo.sameSize && geo.dotX < 1 && geo.labelX < 1, 'sidebar: dots are the same size and dots + text line up');
  check((await page.textContent('#legacyAccessWrap')).indexOf('Access The Red Folder Legacy Vault') !== -1, 'button reads "Access The Red Folder Legacy Vault"');
  check(await page.evaluate(() => document.getElementById('navFamily').nextElementSibling.id === 'legacyAccessWrap'), 'button sits directly under Family Vault');
  await page.screenshot({ path: SHOTS + '/sarah-sidebar.png', clip: { x: 0, y: 0, width: 300, height: 520 } });
  check((await page.textContent('#userLabel')) === 'Sarah · Family Access', 'role badge');
  check(await page.isHidden('#statusBar') && await page.isHidden('#navSettings') && await page.isHidden('#homeUsbNotice'), "Sarah's view: no status bar, no Settings, no USB prompts");
  check(await page.isHidden('#switchDashBtn'), 'Sarah signing in herself sees no switch button');
  check((await page.textContent('#homeDesc')) === 'Everything you need is here. Built with love. 💙' && await page.isVisible('#homeDesc'), "Sarah's home shows the new, simpler line");
  const sarahTiles = await page.$$eval('#quickActions strong', els => els.map(e => e.textContent));
  check(sarahTiles.join('|') === 'Upload a Document|Download a Copy', 'Sarah quick actions: Upload a Document, Download a Copy');
  await page.click('#navFamily'); await waitList();
  check((await fileNames()).length === 3, 'Sarah sees the family documents');
  // Sarah cannot trash James's file in real Drive — friendly message instead of silent failure
  drive.user = 'sarah';
  await page.click('.topbar-btn:has-text("Refresh")'); await waitList();
  await rowFor('notes.png').locator('button', { hasText: 'Remove' }).click();
  await page.waitForSelector('.toast.error');
  check((await page.textContent('.toast.error')).indexOf('uploaded') !== -1, "removing James's file explains Google's owner rule");
  drive.user = 'james';
  await page.click('#navHome');
  await page.click('#inlineLegacyAccess button');
  await page.click('#legacyScreen1 .proceed'); await page.click('#legacyScreen2 .proceed');
  await page.fill('#nameConfirm', 'Sarah');
  await page.click('#unlockBtn');
  await page.waitForSelector('#panel-legacy #fileListLegacy', { timeout: 10000 });
  check((await page.textContent('#userLabel')) === 'Sarah · Full Access', 'Red Folder opens');
  const stateFile = Object.values(drive.files).find(f => f.properties.rf === 'state' && !f.trashed);
  check(!!stateFile && stateFile.content.toString('latin1').indexOf('redFolder') === -1, 'opening is saved to Drive (encrypted)');
  await page.click('#signOutLink');
  await page.waitForSelector('#loginScreen', { state: 'visible', timeout: 10000 });
  check((await page.$$('.rf-overlay')).length === 0, 'Sarah signs out directly — no backup reminder');
  await login('family', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  check((await page.textContent('#userLabel')) === 'Sarah · Full Access' && await page.isVisible('#navLegacy'), 'Red Folder stays open on the next sign-in (permanent)');
  await logout();

  console.log('\n12. James: seal status + re-seal');
  await login('owner', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  check((await page.textContent('#statusRedFolder')).indexOf('Opened') === 0, 'James sees that Sarah opened the Red Folder');
  await page.click('#navSettings');
  await page.click('#resealBtn');
  await page.waitForFunction(() => document.getElementById('statusRedFolder').textContent === 'Sealed', null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent('#statusRedFolder')) === 'Sealed', 're-seal works');
  await page.click('#navHome');
  const jamesTiles = await page.$$eval('#quickActions strong', els => els.map(e => e.textContent));
  check(jamesTiles.join('|') === 'Upload Document|Write a Letter|Record a Message|Downloads & Backups', 'James quick actions: Annual Review + Settings removed, Downloads & Backups added');
  await page.click('#quickActions >> text=Downloads & Backups');
  await page.waitForSelector('.rf-overlay .choice');
  const choiceText = await page.textContent('.rf-overlay');
  check(choiceText.indexOf('USB Offline Copy') !== -1 && choiceText.indexOf('Unencrypted ZIP') !== -1, 'Downloads & Backups offers the USB copy or the ZIP');
  await page.screenshot({ path: SHOTS + '/downloads-menu.png' });
  await page.click('.rf-overlay button:has-text("Close")');


  console.log('\n12b. Red Folder documents + letter');
  await page.click('#navLegacy');
  await page.waitForSelector('#letterBox button:has-text("Write the Letter")', { timeout: 10000 });
  const rfHeads = await page.$$eval('#fileListLegacy .cat-name', els => els.map(e => e.textContent));
  check(rfHeads.join('|') === 'First 72 Hours|Wills & Legal|Finances|Contacts|Home & Car', 'Red Folder categories in order, First 72 Hours at the top');
  await page.click('#letterBox button:has-text("Write the Letter")');
  const LETTER = 'Hi My Love,\n\nThis is a test letter.\n\nForever and Always,\nJames';
  await page.fill('.letter-textarea', LETTER);
  await page.click('#letterBox button:has-text("Save Letter")');
  await page.waitForSelector('#letterBox .letter-preview', { timeout: 10000 });
  const letterFile = Object.values(drive.files).find(f => f.properties.rf === 'letter' && !f.trashed);
  check(!!letterFile && letterFile.content.toString('latin1').indexOf('My Love') === -1, 'letter saved to Drive, encrypted');
  await page.setInputFiles('#fileInputLegacy', [{ name: 'Who to call first.txt', mimeType: 'text/plain', buffer: Buffer.from('Call Mom first.') }]);
  await page.waitForSelector('.rf-overlay .cat-choice', { timeout: 10000 });
  const legacyChoices = await page.$$eval('.rf-overlay .cc-title', els => els.map(e => e.textContent));
  check(legacyChoices[0] === 'First 72 Hours', 'Red Folder upload offers its own categories (First 72 Hours first)');
  await page.click('.rf-overlay .cat-choice:has-text("First 72 Hours")');
  await page.waitForFunction(() => document.querySelectorAll('#fileListLegacy .file-row').length === 1, null, { timeout: 20000 });
  await page.setInputFiles('#fileInputLegacy', [{ name: 'Bank accounts.txt', mimeType: 'text/plain', buffer: Buffer.from('Checking and savings.') }]);
  await page.click('.rf-overlay .cat-choice:has-text("Finances")');
  await page.waitForFunction(() => document.querySelectorAll('#fileListLegacy .file-row').length === 2, null, { timeout: 20000 });
  check((await page.$$('#fileListLegacy [data-category="first-72-hours"] .file-row')).length === 1 && (await page.$$('#fileListLegacy [data-category="finances"] .file-row')).length === 1, 'Red Folder documents land in their categories');
  check((await page.$$('#fileList .file-row')).length === 3, "Red Folder documents don't appear in the Family Vault list");
  await page.click('#navHome');
  check((await page.textContent('#legacyCardCount')).indexOf('2 documents') === 0, 'home card counts Red Folder documents');
  await page.screenshot({ path: SHOTS + '/james-home-v025.png' });
  await page.click('#navLegacy');
  await page.screenshot({ path: SHOTS + '/james-redfolder.png', fullPage: true });

  // USB copy while sealed: Red Folder stays closed until opened
  await page.click('#navSettings');
  const dlUsb2 = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#usbCopyBtn');
  const usb2 = await dlUsb2;
  const usb2Path = '/home/claude/work/shots/usb-with-redfolder.html';
  fs.copyFileSync(await usb2.path(), usb2Path);
  await page.click(".rf-overlay button:has-text(\"I'll Do It Later\")");
  check(fs.readFileSync(usb2Path, 'utf8').indexOf('My Love') === -1 && fs.readFileSync(usb2Path, 'utf8').indexOf('Call Mom') === -1, 'USB copy carries the letter and Red Folder encrypted');
  {
    const ctx = await browser.newContext({ acceptDownloads: true });
    await ctx.route('**/*', r => { const u = r.request().url(); return (u.startsWith('file:') || u.startsWith('blob:') || u.startsWith('data:')) ? r.continue() : r.abort(); });
    const p2 = await ctx.newPage();
    await p2.goto('file://' + usb2Path);
    await p2.fill('#passphrase', "sam's test passphrase 42");
    await p2.click('#unlockBtn');
    await p2.waitForSelector('#vaultScreen', { state: 'visible', timeout: 30000 });
    check(await p2.isVisible('#openRedFolderBtn') && (await p2.textContent('#itemList')).indexOf('Call Mom') === -1 && (await p2.$$('.letter-display')).length === 0, 'offline: Red Folder stays sealed until Sarah chooses to open it');
    const offHeads = await p2.$$eval('.vault-heading', els => els.map(e => e.textContent));
    check(offHeads.join('|') === 'The Red Folder|Family Vault', 'offline: sections are The Red Folder, then Family Vault');
    await p2.click('#openRedFolderBtn');
    await p2.click('.overlay button:has-text("Open It")');
    await p2.waitForSelector('.letter-display');
    check((await p2.textContent('.letter-display')).indexOf('Hi My Love') !== -1, 'offline: the letter shows first when the Red Folder is opened');
    const offCats = await p2.$$eval('#redFolderSection .cat-heading', els => els.map(e => e.textContent));
    check(offCats.length === 2 && offCats[0].indexOf('First 72 Hours') === 0, 'offline: Red Folder documents grouped, First 72 Hours first');
    await p2.screenshot({ path: SHOTS + '/offline-redfolder.png', fullPage: true });
    await ctx.close();
  }

  // Sarah: sealed → open → letter first, view/download only
  await page.click('#signOutLink');
  await page.waitForSelector('.rf-overlay', { timeout: 10000 }).catch(() => {});
  if (await page.isVisible('.rf-overlay')) await page.click('.rf-overlay button:has-text("Sign Out Without Updating")');
  await page.waitForSelector('#loginScreen', { state: 'visible' });
  await login('family', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  await page.click('#navFamily'); await waitList();
  check((await page.$$('#fileList .file-row')).length === 3 && (await page.textContent('#app')).indexOf('Who to call first') === -1, 'Sarah (sealed) cannot see Red Folder documents');
  await page.click('#legacyAccessWrap');
  await page.click('#legacyScreen1 .proceed'); await page.click('#legacyScreen2 .proceed');
  await page.fill('#nameConfirm', 'Sarah');
  await page.click('#unlockBtn');
  await page.waitForSelector('#letterBox.letter-display', { timeout: 10000 });
  check((await page.textContent('#letterBox')).indexOf('Hi My Love') !== -1, "Sarah sees James's letter first, in large type");
  const order = await page.evaluate(() => { const lb = document.getElementById('letterBox'), fl = document.getElementById('fileListLegacy'); return lb.compareDocumentPosition(fl) & Node.DOCUMENT_POSITION_FOLLOWING; });
  check(!!order, 'letter comes before the documents');
  await page.waitForFunction(() => document.querySelectorAll('#fileListLegacy .file-row').length === 2, null, { timeout: 10000 });
  const sarahBtns = await page.$$eval('#fileListLegacy .file-row >> nth=0 >> .file-actions button', els => els.map(e => e.textContent));
  check(sarahBtns.join('|') === 'View|Download', 'Sarah can View and Download Red Folder documents (no editing)');
  const sarahCats = await page.$$eval('#fileListLegacy .cat-name', els => els.map(e => e.textContent));
  check(sarahCats.join('|') === 'First 72 Hours|Finances', 'Sarah sees only filled categories, First 72 Hours first');
  await page.screenshot({ path: SHOTS + '/sarah-redfolder.png', fullPage: true });
  await page.click('#signOutLink');
  await page.waitForSelector('#loginScreen', { state: 'visible' });

  // James re-seals for more testing
  await login('owner', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  check((await page.textContent('#statusRedFolder')).indexOf('Opened') === 0, 'James sees the Red Folder was opened');
  await page.click('#navSettings');
  await page.click('#resealBtn');
  await page.waitForFunction(() => document.getElementById('statusRedFolder').textContent === 'Sealed', null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent('#statusRedFolder')) === 'Sealed', 'James can re-seal the Red Folder after Sarah opens it');
  await page.click('#signOutLink');
  await page.waitForSelector('.rf-overlay', { timeout: 10000 }).catch(() => {});
  if (await page.isVisible('.rf-overlay')) await page.click('.rf-overlay button:has-text("Sign Out Without Updating")');
  await page.waitForSelector('#loginScreen', { state: 'visible' });
  await login('family', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');
  check(await page.isVisible('#legacyAccessWrap') && await page.isHidden('#navLegacy'), "after re-sealing, Sarah's Red Folder is sealed again");
  await logout();
  await login('owner', "sam's test passphrase 42");
  await page.waitForSelector('#app.visible');

  console.log('\n12c. Switch dashboards');
  await page.click('#navHome');
  check(await page.isHidden('#homeDesc'), "James's home has no tagline line");
  check(await page.isVisible('#switchDashBtn') && (await page.textContent('#switchDashBtn')) === "Switch to Sarah's Dashboard", "James sees \"Switch to Sarah's Dashboard\" under his badge");
  check(await page.evaluate(() => { const b = document.getElementById('switchDashBtn'); return b.scrollWidth <= b.clientWidth; }), 'switch button text fits on one line (James view)');
  await page.screenshot({ path: SHOTS + '/switch-james.png', clip: { x: 0, y: 0, width: 300, height: 260 } });
  await page.click('#switchDashBtn');
  await page.waitForFunction(() => document.getElementById('userLabel').textContent === 'Sarah · Family Access', null, { timeout: 5000 });
  check(await page.isHidden('#navLegacy') && await page.isVisible('#legacyAccessWrap') && await page.isHidden('#navSettings'), "switching shows Sarah's sealed dashboard exactly");
  const badge = await page.evaluate(() => {
    const b = document.getElementById('userBadge'), r = b.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(b); const t = range.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { left: t.left - r.left, right: r.right - t.right, color: cs.color, shadow: cs.boxShadow };
  });
  check(badge.left >= 10 && badge.right >= 10 && Math.abs(badge.left - badge.right) < 3, "Sarah's badge text sits comfortably inside the box (even space both sides)");
  check(badge.color === 'rgb(232, 137, 181)' && badge.shadow.indexOf('232, 137, 181') !== -1, "Sarah's badge glows pink like her login button");
  check((await page.textContent('#switchDashBtn')) === "← Back to James's Dashboard", 'a "Back to James\'s Dashboard" button appears');
  check(await page.evaluate(() => { const b = document.getElementById('switchDashBtn'); return b.scrollWidth <= b.clientWidth; }), 'switch button text fits on one line (Sarah view)');
  await page.click('#navFamily'); await waitList();
  check((await page.$$('#fileList .file-row')).length === 3, "Sarah's dashboard lists the family documents (no Red Folder ones)");
  await page.screenshot({ path: SHOTS + '/switch-sarah.png', clip: { x: 0, y: 0, width: 300, height: 260 } });
  await page.click('#switchDashBtn');
  await page.waitForFunction(() => document.getElementById('userLabel').textContent === 'James · Full Access', null, { timeout: 5000 });
  check(await page.isVisible('#navLegacy') && await page.isVisible('#navSettings'), "switching back restores James's full dashboard without signing out");
  check(await page.evaluate(() => masterKey !== null), 'no sign-out happened');
  console.log('\n13. Change passphrase');
  await page.click('#navSettings');
  await page.click('#changePassBtn');
  const pw = page.locator('.rf-overlay input.masked');
  await pw.nth(0).fill('wrong current passphrase');
  await pw.nth(1).fill('brand new family passphrase'); await pw.nth(2).fill('brand new family passphrase');
  await page.click('.rf-overlay button:has-text("Change Passphrase")');
  await page.waitForFunction(() => document.querySelector('.rf-overlay .rf-error').textContent.length > 0, null, { timeout: 20000 });
  check((await page.textContent('.rf-overlay .rf-error')).indexOf('not correct') !== -1, 'wrong current passphrase refused');
  await pw.nth(0).fill("Sam's test passphrase 42");
  await page.click('.rf-overlay button:has-text("Change Passphrase")');
  await page.waitForSelector('text=Passphrase Changed', { timeout: 20000 });
  check(true, 'passphrase changed');
  check((await page.textContent('.rf-overlay')).indexOf('OLD passphrase') !== -1, 'passphrase change shows the urgent USB warning');
  await page.click('.rf-overlay button:has-text("Later")');
  await page.waitForFunction(() => document.getElementById('statusUsb').textContent === 'Old passphrase!', null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent('#statusUsb')) === 'Old passphrase!', 'status shows "Old passphrase!" until the USB copy is replaced');
  await page.click('#signOutLink');
  await page.waitForSelector('.rf-overlay .rf-warn', { timeout: 10000 });
  check((await page.textContent('.rf-overlay .rf-warn')).indexOf('OLD passphrase') !== -1, 'sign-out repeats the urgent passphrase reminder');
  await page.click('.rf-overlay button:has-text("Sign Out Without Updating")');
  await page.waitForSelector('#loginScreen', { state: 'visible' });
  await login('owner', "sam's test passphrase 42");
  check((await page.textContent('#loginError')).indexOf('Incorrect') !== -1, 'old passphrase no longer works');
  await login('owner', 'Brand New Family Passphrase');
  await page.waitForSelector('#app.visible');
  await page.click('#navFamily'); await waitList();
  await rowFor('notes.txt').locator('button', { hasText: 'View' }).click();
  await page.waitForSelector('.viewer-body pre');
  check((await page.textContent('.viewer-body pre')).indexOf('second notes file') !== -1 || (await page.textContent('.viewer-body pre')).indexOf('Hello') !== -1, 'existing documents still open after the change (nothing re-encrypted)');
  await page.click('.viewer-close');
  await logout();

  console.log('\n14. Missing / restored vault key');
  const kf = Object.values(drive.files).find(f => f.properties.rf === 'vaultkey');
  const savedDoc = kf.content;
  kf.trashed = true;
  await login('owner', 'brand new family passphrase');
  check((await page.textContent('#loginError')).indexOf('missing') !== -1 && !(await page.isVisible('#setupView')), 'missing key file: clear message, and NO accidental re-setup over existing documents');
  addFile({ name: 'red-folder-vault-key.json', mimeType: 'application/json', content: savedDoc }); // restored by hand, no tags
  await login('owner', 'brand new family passphrase');
  await page.waitForSelector('#app.visible', { timeout: 20000 });
  check(true, 'a backup copy uploaded by hand (no tags) is found by name and works');
  await logout();

  console.log('\n15. Edge cases');
  addFile({ name: 'vault-item-garbage', description: 'rf1:AAAA', properties: { rf: 'item' }, content: Buffer.from('junk') });
  await page.evaluate(() => { window.__closePopup = true; });
  await page.evaluate(() => { accessToken = null; });
  await login('owner', 'brand new family passphrase');
  check((await page.textContent('#loginError')).indexOf('closed before finishing') !== -1, 'closing the Google window gives a clear message');
  await page.evaluate(() => { window.__closePopup = false; window.__denyScope = true; });
  await login('owner', 'brand new family passphrase');
  check((await page.textContent('#loginError')).indexOf('Google Drive box') !== -1, 'unticking the Drive permission is explained (the old invisible-files trap)');
  await page.evaluate(() => { window.__denyScope = false; });
  await login('owner', 'brand new family passphrase');
  await page.waitForSelector('#app.visible');
  await page.click('#navFamily'); await waitList();
  check((await fileNames()).includes('Unreadable item'), 'a damaged item shows as unreadable instead of breaking the list');
  check((await rowFor('Unreadable item').locator('button').count()) === 1, 'damaged item offers only Remove');

  console.log('\n16. Auto sign-out');
  await page.evaluate(() => { lastActivity = Date.now() - 31 * 60 * 1000; });
  await page.waitForSelector('#loginScreen', { state: 'visible', timeout: 40000 });
  check((await page.textContent('#loginError')).indexOf('30 minutes') !== -1, 'signs out after 30 idle minutes');

  console.log('\n17. Phone layout');
  await page.setViewportSize({ width: 375, height: 667 });
  await page.screenshot({ path: SHOTS + '/phone-login.png', fullPage: true });
  await login('owner', 'brand new family passphrase');
  await page.waitForSelector('#app.visible');
  await page.waitForTimeout(900);
  await page.screenshot({ path: SHOTS + '/phone-home.png', fullPage: true });
  await page.click('.hamburger'); await page.click('#navFamily'); await waitList();
  await page.screenshot({ path: SHOTS + '/phone-family.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'no sideways scrolling on a phone');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#navHome');
  await page.waitForTimeout(900);
  await page.screenshot({ path: SHOTS + '/desktop-home.png' });
  await page.click('#navSettings');
  await page.screenshot({ path: SHOTS + '/desktop-settings.png', fullPage: true });
  await logout();
  await page.screenshot({ path: SHOTS + '/desktop-login.png' });


  console.log('\n18. Start Fresh (one time) → real passphrase');
  await page.setViewportSize({ width: 1280, height: 900 });
  // an unrelated file in the folder must survive
  addFile({ name: 'Unrelated family photo.jpg', content: Buffer.from('keep me') });
  // Simulate James's real situation: a vault key made by v0.21-v0.27 (no "cleanStart" mark)
  const liveKey = Object.values(drive.files).find(f => !f.trashed && (f.properties.rf === 'vaultkey' || f.name === 'red-folder-vault-key.json'));
  const kd = JSON.parse(liveKey.content.toString()); delete kd.cleanStart; liveKey.content = Buffer.from(JSON.stringify(kd));
  await login('owner', 'brand new family passphrase');
  await page.waitForSelector('#app.visible');
  await page.click('#navSettings');
  check(await page.isVisible('#startFreshCard'), 'Start Fresh card shows while the vault uses a key from testing');
  const oldKeyContent = liveKey.content;
  const before = Object.values(drive.files).length;
  await page.click('#startFreshBtn');
  await page.waitForFunction(() => /Found \d+ vault/.test(document.querySelector('.rf-overlay').textContent), null, { timeout: 10000 });
  check((await page.textContent('.rf-overlay')).indexOf('including any in the trash') !== -1, 'Start Fresh counts test files, including trashed ones');
  await page.fill('.rf-overlay input', 'start');
  await page.click('.rf-overlay button:has-text("Delete Everything and Start Fresh")');
  check((await page.textContent('.rf-overlay .rf-error')).indexOf('START FRESH') !== -1, 'must type START FRESH to confirm');
  await page.fill('.rf-overlay input', 'START FRESH');
  await page.click('.rf-overlay button:has-text("Delete Everything and Start Fresh")');
  await page.waitForSelector('#setupView', { state: 'visible', timeout: 20000 });
  check((await page.textContent('#setupStatus')).indexOf('permanently deleted') !== -1, 'goes straight to choosing the real passphrase');
  const left = Object.values(drive.files);
  check(left.every(f => !f.properties.rf && !/\.vaultenc$|\.note$/.test(f.name) && f.name !== 'red-folder-vault-key.json'), 'every test file is permanently gone — key, documents, notes, letter, state, trashed items, old v0.19 files');
  check(left.some(f => f.name === 'Unrelated family photo.jpg'), 'unrelated files in the folder are not touched');
  check(await page.evaluate(() => masterKey === null && vaultKeyDoc === null), 'old vault key cleared from memory');
  await page.fill('#setupPass1', 'Real Words Rolled With Dice Today'); await page.fill('#setupPass2', 'real words rolled with dice today');
  await page.check('#setupAck');
  await page.click('#setupCreate');
  await page.waitForSelector('#app.visible', { timeout: 20000 });
  check(true, 'new vault created with the real passphrase (no second Google sign-in needed)');
  const newKey = Object.values(drive.files).find(f => f.properties.rf === 'vaultkey');
  check(JSON.parse(newKey.content.toString()).cleanStart === true && !newKey.content.equals(oldKeyContent), 'brand-new vault key, marked clean');
  await page.click('.rf-overlay .btn.gold');
  await page.click('#navSettings');
  check(await page.isHidden('#startFreshCard'), 'Start Fresh card disappears for good');
  await page.click('#navFamily'); await waitList();
  check((await page.$$('#fileList .file-row')).length === 0, 'the new vault starts empty');
  await logout();
  await login('owner', 'brand new family passphrase');
  check((await page.textContent('#loginError')).indexOf('Incorrect') !== -1, 'the practice passphrase no longer opens anything');
  await login('owner', 'real words rolled with dice today');
  await page.waitForSelector('#app.visible');
  check(true, 'the real passphrase opens the new vault');
  await logout();

  console.log('\nSecurity-policy blocks:', cspBlocks.length ? cspBlocks : 'none');
  console.log('Unexpected console errors:', consoleErrors.length ? consoleErrors : 'none');
  check(cspBlocks.length === 0, 'no Content-Security-Policy violations');
  check(consoleErrors.length === 0, 'no unexpected script errors');
  console.log('\nRESULT: ' + passes + ' passed, ' + failures + ' failed');
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH', e); process.exit(2); });

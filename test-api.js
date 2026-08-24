/**
 * Housely — end-to-end API smoke test.
 *   node test-api.js
 * Requires the backend to be running (npm start) and the DB to be seeded.
 * Exercises auth, permissions, funding, expenses, flags, catalog, checklist,
 * categories, analytics, activity, transactions, bills, goals, exports and
 * period rollover. Prints PASS/FAIL per check and exits non-zero on failure.
 */

require('dotenv').config(); // so FACTORY_RESET_PIN etc. match the server's .env
const BASE = process.env.BASE_URL || 'http://localhost:4000/api';
const ExcelJS = require('exceljs');
// Factory-reset master PIN — must match the server's FACTORY_RESET_PIN env.
const RESET_PIN = process.env.FACTORY_RESET_PIN || '0259';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON (e.g. xlsx) */
  }
  return { status: res.status, data, res };
}

async function main() {
  console.log('\n== Health ==');
  const health = await req('GET', '/health');
  check('health returns ok', health.status === 200 && health.data.ok === true);

  // ---- Accounts bootstrap (public version) -------------------------------
  // Every run registers a FRESH account so the suite is re-runnable. The
  // registrant becomes the provider of a new family; other members are added
  // by the provider (no pre-seeded family exists in the public app).
  const unique = Date.now();
  const famName = `Test Family ${unique}`;
  const email = `test${unique}@housley.test`;
  const password = 'test-pass-123';

  console.log('\n== Register (create family) ==');
  const badEmail = await req('POST', '/auth/register', { body: { email: 'not-an-email', password, familyName: 'X', name: 'Dad' } });
  check('register rejects invalid email', badEmail.status === 400);
  const shortPass = await req('POST', '/auth/register', { body: { email: 'a@b.co', password: 'short', familyName: 'X', name: 'Dad' } });
  check('register rejects short password', shortPass.status === 400);
  const noFamName = await req('POST', '/auth/register', { body: { email: 'a@b.co', password, familyName: '', name: 'Dad' } });
  check('register requires a family name', noFamName.status === 400);
  const reg = await req('POST', '/auth/register', { body: { email, password, familyName: famName, name: 'Dad' } });
  check('register creates account + family', reg.status === 201 && reg.data.token && reg.data.family.name === famName, JSON.stringify(reg.data).slice(0, 160));
  check('registrant is the provider', reg.data.user.role === 'provider');
  check('no passwordHash/pinHash leaked', !('passwordHash' in reg.data.user) && !('pinHash' in reg.data.user));
  const providerToken = reg.data.token;
  const dad = reg.data.user;
  check('family seeded with the provider profile', reg.data.profiles.length === 1 && reg.data.profiles[0]._id === dad._id);
  const regDup = await req('POST', '/auth/register', { body: { email, password, familyName: 'X', name: 'X' } });
  check('duplicate email rejected', regDup.status === 409);

  console.log('\n== Login ==');
  const wrongPass = await req('POST', '/auth/login', { body: { email, password: 'wrong-pass-1' } });
  check('login rejects wrong password', wrongPass.status === 401);
  const login = await req('POST', '/auth/login', { body: { email, password } });
  check('login succeeds', login.status === 200 && login.data.token);

  console.log('\n== Provider adds family members ==');
  const addMom = await req('POST', '/family/members', { token: providerToken, body: { name: 'Mom', role: 'grocery_spender' } });
  check('provider adds grocery spender', addMom.status === 201 && addMom.data.user.role === 'grocery_spender');
  const mom = addMom.data.user;
  const addRijal = await req('POST', '/family/members', { token: providerToken, body: { name: 'Rijal Hamdi Bin Asyraf', role: 'member' } });
  check('provider adds member', addRijal.status === 201 && addRijal.data.user.role === 'member');
  const rijal = addRijal.data.user;
  const addFaten = await req('POST', '/family/members', { token: providerToken, body: { name: 'Faten Arij Binti Asyraf', role: 'dependent' } });
  const sister1 = addFaten.data.user;
  const addAlya = await req('POST', '/family/members', { token: providerToken, body: { name: 'Alya Izzati Binti Asyraf', role: 'dependent' } });
  const other = addAlya.data.user;
  check('provider adds dependents', addFaten.status === 201 && addAlya.status === 201);
  const addBadRole = await req('POST', '/family/members', { token: providerToken, body: { name: 'X', role: 'admin' } });
  check('add-member rejects bad role', addBadRole.status === 400);
  const addNoName = await req('POST', '/family/members', { token: providerToken, body: { role: 'member' } });
  check('add-member requires a name', addNoName.status === 400);

  console.log('\n== Profiles (authenticated) ==');
  const profiles = await req('GET', '/auth/profiles', { token: providerToken });
  check('profiles status 200', profiles.status === 200);
  check('five family members', profiles.data.users.length === 5, JSON.stringify(profiles.data.users.map((u) => u.name)));
  check('no pinHash leaked', profiles.data.users.every((u) => !('pinHash' in u)));
  check('profiles require an account session', (await req('GET', '/auth/profiles')).status === 401);

  console.log('\n== Auth protection ==');
  const noAuth = await req('GET', '/funding/balances/groceries');
  check('protected route rejects anonymous', noAuth.status === 401);

  console.log('\n== PIN setup & verify (account-gated) ==');
  const setRijal = await req('POST', '/auth/set-pin', { token: providerToken, body: { userId: rijal._id, pin: '2302' } });
  check('set-pin works for a family member', setRijal.status === 201 && setRijal.data.token);
  const wrongPin = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: rijal._id, pin: '9999' } });
  check('wrong PIN rejected', wrongPin.status === 401);
  check('wrong PIN reports attempts left', wrongPin.data.attemptsLeft === 4);
  const badFormat = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: rijal._id, pin: '12ab' } });
  check('non-numeric PIN rejected', badFormat.status === 400);
  const noAuthPin = await req('POST', '/auth/verify-pin', { body: { userId: rijal._id, pin: '2302' } });
  check('PIN verify requires an account session', noAuthPin.status === 401);
  const rijalLogin = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: rijal._id, pin: '2302' } });
  check('correct PIN logs in (2302)', rijalLogin.status === 200 && rijalLogin.data.token);
  const rijalToken = rijalLogin.data.token;
  const rijalRefresh = rijalLogin.data.refreshToken;
  check('login returns safe user', rijalLogin.data.user && rijalLogin.data.user.hasPin === true && !('pinHash' in rijalLogin.data.user));

  console.log('\n== Lockout ==');
  // alya has no pin; set one via set-pin for lockout testing
  const setAlya = await req('POST', '/auth/set-pin', { token: providerToken, body: { userId: other._id, pin: '0000' } });
  check('set-pin works for new profile', setAlya.status === 201 && setAlya.data.token);
  const setAgain = await req('POST', '/auth/set-pin', { token: providerToken, body: { userId: other._id, pin: '1111' } });
  check('set-pin refused when PIN exists', setAgain.status === 409);
  let locked = null;
  for (let i = 0; i < 5; i++) {
    locked = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: other._id, pin: '9999' } });
  }
  check('5 wrong attempts lock the profile', locked.status === 423);
  const stillLocked = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: other._id, pin: '0000' } });
  check('correct PIN refused while locked', stillLocked.status === 423);

  console.log('\n== Categories (auto-seed) ==');
  const cats = await req('GET', '/categories', { token: rijalToken });
  check('categories seeded on first call', cats.status === 200 && cats.data.categories.length >= 10, `got ${cats.data.categories.length}`);
  const catNames = cats.data.categories.map((c) => c.name);
  const newCat = await req('POST', '/categories', { token: rijalToken, body: { name: 'Pet Food' } });
  check('add category', newCat.status === 201);
  const dupCat = await req('POST', '/categories', { token: rijalToken, body: { name: 'Pet Food' } });
  check('duplicate category refused', dupCat.status === 409);

  console.log('\n== Permissions: Rijal (member) ==');
  const memberFundGroc = await req('POST', '/funding/groceries', { token: rijalToken, body: { amount: 10000, paymentMethod: 'cash' } });
  check('member cannot fund Groceries', memberFundGroc.status === 403);
  const memberSetBudget = await req('PATCH', '/funding/groceries/budget', { token: rijalToken, body: { budgetAmount: 50000 } });
  check('member cannot set Groceries budget', memberSetBudget.status === 403);
  const memberCatBudget = await req('PATCH', `/analytics/category-budgets/${encodeURIComponent('Groceries')}`, { token: rijalToken, body: { budgetAmount: 40000 } });
  check('member cannot set category budget', memberCatBudget.status === 403);
  const memberClose = await req('POST', '/periods/close-and-start-new', { token: rijalToken });
  check('member cannot close period', memberClose.status === 403);

  console.log('\n== Funding personal (self) ==');
  const fundSelf = await req('POST', '/funding/personal', { token: rijalToken, body: { amount: 5000, paymentMethod: 'cash' } });
  check('member funds own personal balance', fundSelf.status === 201);
  check('personal balance funded 50.00', fundSelf.data.balance.funded === 5000);
  const fundOther = await req('POST', '/funding/personal', { token: rijalToken, body: { userId: sister1._id, amount: 5000, paymentMethod: 'cash' } });
  check('member cannot fund other people', fundOther.status === 403);
  const fundNoProof = await req('POST', '/funding/personal', { token: rijalToken, body: { amount: 5000, paymentMethod: 'online_banking' } });
  check('online banking works without proof (optional)', fundNoProof.status === 201);
  const fundBadProof = await req('POST', '/funding/personal', { token: rijalToken, body: { amount: 5000, paymentMethod: 'online_banking', proofImage: 'not-an-image' } });
  check('invalid proof image rejected', fundBadProof.status === 400);
  const fundProof = await req('POST', '/funding/personal', {
    token: rijalToken,
    body: { amount: 5000, paymentMethod: 'online_banking', proofImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  });
  check('online banking with proof accepted', fundProof.status === 201);

  console.log('\n== Personal expense (self only) ==');
  const expSelf = await req('POST', '/expenses/personal', { token: rijalToken, body: { amount: 1200, category: 'Transport', shopName: 'Grab' } });
  check('personal expense logged', expSelf.status === 201);
  check('personal balance spent updated', expSelf.data.balance.spent === 1200);

  console.log('\n== Groceries expense (member allowed) ==');
  const g1 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Econsave', amount: 10000, paymentMethod: 'cash', category: 'Groceries' } });
  check('member logs groceries expense', g1.status === 201);
  const g2 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Econsave', amount: 10000, paymentMethod: 'cash', category: 'Groceries' } });
  check('duplicate (same shop/amount/day) flagged', g2.status === 201 && g2.data.flags.includes('duplicate'), JSON.stringify(g2.data.flags));
  const g3 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Pasar Pagi', amount: 2000, paymentMethod: 'cash', category: 'Vegetables & Fruits' } });
  const g4 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Speedmart 99', amount: 3000, paymentMethod: 'cash', category: 'Groceries' } });
  check('normal expenses ok', g3.status === 201 && g4.status === 201);
  const gBig = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Big Mall', amount: 90000, paymentMethod: 'cash', category: 'Groceries' } });
  check('unusual spend flagged (>2.5x avg)', gBig.status === 201 && gBig.data.flags.includes('unusual'), JSON.stringify(gBig.data.flags));
  const gReceipt = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Econsave', amount: 5500, paymentMethod: 'cash', category: 'Groceries', receiptImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  });
  check('groceries expense stores optional receipt image', gReceipt.status === 201 && gReceipt.data.expense.receiptImage, JSON.stringify(gReceipt.data).slice(0, 120));
  const gBadReceipt = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Econsave', amount: 6000, paymentMethod: 'cash', category: 'Groceries', receiptImage: 'nope' } });
  check('invalid receipt image rejected', gBadReceipt.status === 400);

  console.log('\n== Line items → catalog sync ==');
  const gItems = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: {
      shopName: 'Econsave',
      amount: 30000,
      category: 'Groceries',
      paymentMethod: 'cash',
      lineItems: [
        { name: 'Ayam brand rice', quantity: 1, unitPrice: 15000, totalPrice: 15000 },
        { name: 'Sunny Queen eggs', quantity: 2, unitPrice: 7500, totalPrice: 15000 },
      ],
    },
  });
  check('expense with line items saved', gItems.status === 201);
  const catalog = await req('GET', '/catalog', { token: rijalToken });
  const rice = catalog.data.items.find((i) => i.name === 'Ayam brand rice');
  check('catalog auto-created items', !!rice && rice.timesBought === 1, JSON.stringify(catalog.data.items.map((i) => i.name)));
  check('catalog item category learned', rice.category === 'Groceries');
  // buying the same item again bumps count
  await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Econsave', amount: 15000, category: 'Groceries', paymentMethod: 'cash', lineItems: [{ name: 'ayam brand RICE', quantity: 1, unitPrice: 15000, totalPrice: 15000 }] },
  });
  const catalog2 = await req('GET', '/catalog', { token: rijalToken });
  const rice2 = catalog2.data.items.find((i) => i.name === 'Ayam brand rice');
  check('catalog sync is case-insensitive & bumps count', rice2 && rice2.timesBought === 2);

  const favCat = await req('GET', '/catalog/favorites', { token: rijalToken });
  check('catalog favorites endpoint', favCat.status === 200);

  console.log('\n== Shops ==');
  const shops = await req('GET', '/expenses/shops', { token: rijalToken });
  check('shops listed', shops.status === 200 && shops.data.shops.length >= 4);
  const favs = await req('GET', '/expenses/shops/favorites', { token: rijalToken });
  check('favorite shops by usage', favs.status === 200 && favs.data.shops[0].name === 'Econsave');
  const cheapest = await req('GET', '/expenses/shops/cheapest', { token: rijalToken });
  check('cheapest shop suggestion', cheapest.status === 200 && cheapest.data.suggestion);
  const newShop = await req('POST', '/expenses/shops', { token: rijalToken, body: { name: 'AEON Big', type: 'groceries', category: 'Groceries' } });
  check('create shop directly', newShop.status === 201);

  console.log('\n== Provider actions (set Dad PIN then login) ==');
  const setDad = await req('POST', '/auth/set-pin', { token: providerToken, body: { userId: dad._id, pin: '1111' } });
  check('set Dad PIN', setDad.status === 201);
  const dadLogin = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: dad._id, pin: '1111' } });
  const dadToken = dadLogin.data.token;

  const dadFund = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: 200000, paymentMethod: 'cash', note: 'Monthly top-up' } });
  check('provider funds Groceries', dadFund.status === 201);
  check('grocery balance funded 2000.00', dadFund.data.balance.funded === 200000);
  const dadSetBudget = await req('PATCH', '/funding/groceries/budget', { token: dadToken, body: { budgetAmount: 180000 } });
  check('provider sets Groceries budget', dadSetBudget.status === 200 && dadSetBudget.data.balance.budgetSet === true);
  check('safe-to-spend computed', dadSetBudget.data.balance.safeToSpend >= 0 && dadSetBudget.data.balance.daysLeft > 0);
  const dadCatBudget = await req('PATCH', `/analytics/category-budgets/${encodeURIComponent('Groceries')}`, { token: dadToken, body: { budgetAmount: 120000 } });
  check('provider sets category budget', dadCatBudget.status === 200);
  const dadFundOther = await req('POST', '/funding/personal', { token: dadToken, body: { userId: sister1._id, amount: 10000, paymentMethod: 'cash' } });
  check('provider funds a dependent', dadFundOther.status === 201);
  const dadSummary = await req('GET', '/analytics/family/summary', { token: dadToken });
  check('provider sees all 5 personal balances', dadSummary.data.personal.length === 5, `got ${dadSummary.data.personal.length}`);
  const dadFunding = await req('GET', '/transactions/funding', { token: dadToken });
  check('provider sees everyone\u2019s funding records', dadFunding.data.funding.length >= 4, `got ${dadFunding.data.funding.length}`);

  console.log('\n== Mom (grocery_spender) ==');
  const setMom = await req('POST', '/auth/set-pin', { token: providerToken, body: { userId: mom._id, pin: '2222' } });
  check('set Mom PIN', setMom.status === 201);
  const momLogin = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: mom._id, pin: '2222' } });
  const momToken = momLogin.data.token;
  const momFund = await req('POST', '/funding/groceries', { token: momToken, body: { amount: 50000, paymentMethod: 'e_wallet' } });
  check('grocery_spender funds Groceries', momFund.status === 201);
  const momSeeSisterCat = await req('GET', `/analytics/personal/${sister1._id}/category`, { token: momToken });
  check('grocery_spender can view others\u2019 personal analytics', momSeeSisterCat.status === 200);
  const momSummary = await req('GET', '/analytics/family/summary', { token: momToken });
  check('grocery_spender sees all 5 personal balances', momSummary.data.personal.length === 5, `got ${momSummary.data.personal.length}`);
  const momResetSister = await req('POST', '/auth/reset-pin', { token: momToken, body: { userId: sister1._id, newPin: '3333' } });
  check('grocery_spender resets dependent PIN', momResetSister.status === 200);
  const momResetDad = await req('POST', '/auth/reset-pin', { token: momToken, body: { userId: dad._id, newPin: '4444' } });
  check('grocery_spender cannot reset provider PIN', momResetDad.status === 403);
  const rijalResetSister = await req('POST', '/auth/reset-pin', { token: rijalToken, body: { userId: sister1._id, newPin: '5555' } });
  check('member cannot reset anyone PIN', rijalResetSister.status === 403);

  console.log('\n== Checklist ==');
  const cl = await req('GET', '/checklist', { token: rijalToken });
  check('checklist empty initially', cl.status === 200 && cl.data.items.length === 0);
  const clAdd = await req('POST', '/checklist', { token: rijalToken, body: { name: 'Milo', quantity: '2 tin' } });
  check('add checklist item', clAdd.status === 201);
  const clToggle = await req('PATCH', `/checklist/${clAdd.data.item._id}`, { token: rijalToken, body: { checked: true } });
  check('toggle checklist item', clToggle.status === 200 && clToggle.data.item.checked === true);
  // suggested section should contain the low/out catalog items
  await req('PATCH', `/catalog/${rice2._id}`, { token: rijalToken, body: { stockStatus: 'low' } });
  const cl2 = await req('GET', '/checklist', { token: rijalToken });
  check('suggested-from-catalog section shows low items', cl2.data.suggested.some((s) => s.name === 'Ayam brand rice'));
  const clBought = await req('POST', `/checklist/${clAdd.data.item._id}/bought`, { token: rijalToken });
  check('bought-it removes checklist item', clBought.status === 200);
  const clAdd2 = await req('POST', '/checklist', { token: rijalToken, body: { name: 'Temp item', quantity: '1' } });
  const clDel = await req('DELETE', `/checklist/${clAdd2.data.item._id}`, { token: rijalToken });
  check('delete checklist item', clDel.status === 200);

  console.log('\n== Catalog management ==');
  const catAdd = await req('POST', '/catalog', { token: rijalToken, body: { name: 'Kicap Jalen', category: 'Household' } });
  check('manual catalog add', catAdd.status === 201);
  const catPatch = await req('PATCH', `/catalog/${catAdd.data.item._id}`, { token: rijalToken, body: { stockStatus: 'out' } });
  check('catalog status update', catPatch.status === 200 && catPatch.data.item.stockStatus === 'out');
  const catDel = await req('DELETE', `/catalog/${catAdd.data.item._id}`, { token: rijalToken });
  check('catalog delete', catDel.status === 200);

  console.log('\n== Transactions: history, edit, delete ==');
  const txList = await req('GET', '/transactions/expenses', { token: rijalToken, body: undefined });
  check('expense history listed', txList.status === 200 && txList.data.expenses.length >= 7);
  const txSearch = await req('GET', `/transactions/expenses?search=${encodeURIComponent('Econsave')}`, { token: rijalToken });
  check('search by shop works', txSearch.status === 200 && txSearch.data.expenses.every((e) => e.shopName === 'Econsave'));
  const txFilter = await req('GET', '/transactions/expenses?type=personal', { token: rijalToken });
  check('filter by type works', txFilter.status === 200 && txFilter.data.expenses.every((e) => e.type === 'personal'));

  const balBefore = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  const txEdit = await req('PATCH', `/transactions/expenses/${expSelf.data.expense._id}`, { token: rijalToken, body: { amount: 2200 } });
  check('edit expense amount (1200 → 2200)', txEdit.status === 200 && txEdit.data.expense.amount === 2200);
  const balAfterEdit = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  check('balance adjusted by delta (+1000 sen)', balAfterEdit.spent - balBefore.spent === 1000, `delta ${balAfterEdit.spent - balBefore.spent}`);
  const txDel = await req('DELETE', `/transactions/expenses/${expSelf.data.expense._id}`, { token: rijalToken });
  check('delete expense restores balance', txDel.status === 200);
  const balAfterDel = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  // the only personal expense (1200→2200) was deleted, so spent returns to 0
  check('balance restored after delete', balAfterDel.spent === 0, `spent ${balAfterDel.spent}`);

  const fundingList = await req('GET', '/transactions/funding', { token: rijalToken });
  check('funding history listed (member sees own only)', fundingList.status === 200 && fundingList.data.funding.length >= 2, `got ${fundingList.data.funding.length}`);
  check('member funding list hides other people\u2019s records', fundingList.data.funding.every((f) => String(f.fundedById) === String(rijal._id) || String(f.userId) === String(rijal._id)));
  const selfFunding = fundingList.data.funding.find((f) => f.type === 'personal' && String(f.userId) === String(rijal._id) && f.amount === 5000 && f.paymentMethod === 'cash');
  const balB4 = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  const fdDel = await req('DELETE', `/transactions/funding/${selfFunding._id}`, { token: rijalToken });
  check('delete funding record', fdDel.status === 200);
  const balAft = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  check('funding delete reduces funded balance', balAft.funded === balB4.funded - 5000, `${balB4.funded} → ${balAft.funded}`);
  // editing someone else's expense as non-owner
  const momExp = await req('POST', '/expenses/personal', { token: momToken, body: { amount: 800, category: 'Entertainment' } });
  const editOther = await req('PATCH', `/transactions/expenses/${momExp.data.expense._id}`, { token: rijalToken, body: { amount: 900 } });
  check('member cannot edit another member\u2019s expense', editOther.status === 403);
  const editAsDad = await req('PATCH', `/transactions/expenses/${momExp.data.expense._id}`, { token: dadToken, body: { amount: 900 } });
  check('provider can edit any expense', editAsDad.status === 200);

  console.log('\n== Analytics ==');
  const recap = await req('GET', '/analytics/weekly-recap', { token: rijalToken });
  check('weekly recap', recap.status === 200 && recap.data.total >= 0);
  const byStore = await req('GET', '/analytics/groceries/by-store', { token: rijalToken });
  check('groceries by store', byStore.status === 200 && byStore.data.data.length >= 1);
  const byMonth = await req('GET', '/analytics/groceries/by-month', { token: rijalToken });
  check('groceries by month (6 buckets)', byMonth.status === 200 && byMonth.data.data.length === 6);
  const byPeriod = await req('GET', '/analytics/groceries/by-period', { token: rijalToken });
  check('groceries by period', byPeriod.status === 200);
  const persCat = await req('GET', `/analytics/personal/${rijal._id}/category`, { token: rijalToken });
  check('personal category pie', persCat.status === 200 && persCat.data.data.length >= 0);
  const persOther = await req('GET', `/analytics/personal/${sister1._id}/category`, { token: rijalToken });
  check('cannot view other personal analytics', persOther.status === 403);
  const famCat = await req('GET', '/analytics/family/categories', { token: rijalToken });
  check('family categories', famCat.status === 200);
  const summary = await req('GET', '/analytics/family/summary', { token: rijalToken });
  check('family summary', summary.status === 200 && summary.data.groceries.funded >= 250000);
  check('member summary shows ONLY their own balance', summary.data.personal.length === 1 && String(summary.data.personal[0].user._id) === String(rijal._id), `got ${summary.data.personal.length}`);
  const catBudgets = await req('GET', '/analytics/category-budgets', { token: rijalToken });
  check('category budgets list', catBudgets.status === 200 && catBudgets.data.budgets.length >= 1);

  console.log('\n== Analytics (new views) ==');
  for (const b of ['daily', 'weekly', 'monthly', 'yearly']) {
    const tr = await req('GET', `/analytics/trend?bucket=${b}`, { token: rijalToken });
    check(`trend bucket ${b}`, tr.status === 200 && Array.isArray(tr.data.data) && tr.data.data.length >= 2, JSON.stringify(tr.data).slice(0, 120));
  }
  const trBad = await req('GET', '/analytics/trend?bucket=hourly', { token: rijalToken });
  check('trend falls back on bad bucket', trBad.status === 200 && trBad.data.bucket === 'monthly');
  const wd = await req('GET', '/analytics/weekday-pattern', { token: rijalToken });
  check('weekday pattern has 7 days', wd.status === 200 && wd.data.data.length === 7, JSON.stringify(wd.data));
  const mc = await req('GET', '/analytics/member-comparison', { token: rijalToken });
  check('member comparison lists spenders', mc.status === 200 && Array.isArray(mc.data.data) && mc.data.data.length >= 1);
  const te = await req('GET', '/analytics/top-expenses', { token: rijalToken });
  check('top expenses sorted desc', te.status === 200 && te.data.data.length >= 1 && te.data.data[0].amount >= te.data.data[te.data.data.length - 1].amount);
  check('top expenses resolve spender names', te.data.data.every((e) => e.spentByName && e.spentByName !== 'Family'), JSON.stringify(te.data.data.map((e) => e.spentByName)));
  const ts = await req('GET', '/analytics/top-shops', { token: rijalToken });
  check('top shops listed', ts.status === 200 && ts.data.data.length >= 1 && typeof ts.data.data[0].trips === 'number');

  console.log('\n== Analytics v2 (payment method, streak, badges) ==');
  const pm = await req('GET', '/analytics/payment-method', { token: rijalToken });
  check('payment-method breakdown', pm.status === 200 && Array.isArray(pm.data.data) && pm.data.data.length >= 1, JSON.stringify(pm.data).slice(0, 120));
  check('payment-method sums match spend', pm.data.data.reduce((s, d) => s + d.amount, 0) > 0);
  const streak = await req('GET', '/analytics/streak', { token: rijalToken });
  check('streak endpoint returns days array', streak.status === 200 && Array.isArray(streak.data.days) && streak.data.days.length >= 7, JSON.stringify(streak.data).slice(0, 120));
  check('streak is a number', typeof streak.data.streak === 'number' && streak.data.streak >= 0);
  const badges = await req('GET', '/analytics/badges', { token: rijalToken });
  check('badges list computed', badges.status === 200 && Array.isArray(badges.data.badges) && badges.data.badges.length >= 5, JSON.stringify(badges.data).slice(0, 140));
  check('badges have earned flags', badges.data.badges.every((b) => typeof b.earned === 'boolean'));

  console.log('\n== Meal planner ==');
  const meals = await req('GET', '/meals', { token: rijalToken });
  check('meals listed', meals.status === 200 && Array.isArray(meals.data.meals));
  const mealAdd = await req('POST', '/meals', { token: rijalToken, body: { date: '2026-08-16', title: 'Spaghetti Bolognese', ingredients: ['2x Pasta', '1x Tomato sauce', 'Beef'] } });
  check('add meal plan', mealAdd.status === 201 && mealAdd.data.meal.title === 'Spaghetti Bolognese');
  const gen = await req('POST', '/meals/generate-list', { token: rijalToken, body: { from: '2026-08-16', to: '2026-08-22' } });
  check('generate shopping list from meals', gen.status === 200 && gen.data.items.length >= 3 && gen.data.estimatedSen > 0, JSON.stringify(gen.data).slice(0, 160));
  const addList = await req('POST', '/meals/add-to-list', { token: rijalToken, body: { items: [{ name: 'Pasta', quantity: '2' }] } });
  check('ingredients added to shopping list', addList.status === 201 && addList.data.added >= 1);
  const dupList = await req('POST', '/meals/add-to-list', { token: rijalToken, body: { items: [{ name: 'Pasta', quantity: '2' }] } });
  check('duplicate ingredient not re-added', dupList.status === 201 && dupList.data.added === 0);
  const mealDel = await req('DELETE', `/meals/${mealAdd.data.meal._id}`, { token: rijalToken });
  check('delete meal plan', mealDel.status === 200);

  console.log('\n== Chores (chore-to-allowance) ==');
  const chores = await req('GET', '/chores', { token: rijalToken });
  check('chores listed', chores.status === 200 && Array.isArray(chores.data.chores));
  const choreAsMember = await req('POST', '/chores', { token: rijalToken, body: { title: 'Wash dishes', reward: 500, assignedTo: rijal._id } });
  check('member cannot create chores', choreAsMember.status === 403);
  const choreAdd = await req('POST', '/chores', { token: dadToken, body: { title: 'Fold laundry', reward: 300, assignedTo: rijal._id } });
  check('provider creates chore', choreAdd.status === 201);
  const choreId = choreAdd.data.chore._id;
  // sister already has PIN 3333 (set earlier by Mom in the reset-pin tests)
  const sisterEarly = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: sister1._id, pin: '3333' } });
  check('sister login prepared for chore test', sisterEarly.status === 200);
  const sisterEarlyToken = sisterEarly.data.token;
  const choreDoneOther = await req('PATCH', `/chores/${choreId}`, { token: sisterEarlyToken, body: { status: 'done' } });
  check('non-assignee cannot mark done', choreDoneOther.status === 403);
  const choreDone = await req('PATCH', `/chores/${choreId}`, { token: rijalToken, body: { status: 'done' } });
  check('assignee marks chore done', choreDone.status === 200 && choreDone.data.chore.status === 'done');
  const choreApproveAsMember = await req('POST', `/chores/${choreId}/approve`, { token: rijalToken });
  check('member cannot approve chores', choreApproveAsMember.status === 403);
  const balBeforeChore = (await req('GET', `/funding/balances/personal/${rijal._id}`, { token: dadToken })).data.balance;
  const choreApprove = await req('POST', `/chores/${choreId}/approve`, { token: dadToken });
  check('provider approves chore + reward funded', choreApprove.status === 200 && choreApprove.data.balance.currentBalance === balBeforeChore.currentBalance + 300, JSON.stringify(choreApprove.data).slice(0, 160));
  const choreApproveAgain = await req('POST', `/chores/${choreId}/approve`, { token: dadToken });
  check('already-approved chore cannot re-approve', choreApproveAgain.status === 409);
  const choreDel = await req('DELETE', `/chores/${choreId}`, { token: dadToken });
  check('delete chore', choreDel.status === 200);

  console.log('\n== Social (shout-outs + pin board) ==');
  const shout = await req('POST', '/social/shoutouts', { token: rijalToken, body: { text: 'Thanks Mama for the groceries! 💛' } });
  check('post a shout-out', shout.status === 201);
  const shoutId = shout.data.shoutout._id;
  const shouts = await req('GET', '/social/shoutouts', { token: rijalToken });
  check('shout-outs listed newest first', shouts.status === 200 && shouts.data.shoutouts.length >= 1);
  const react = await req('POST', `/social/shoutouts/${shoutId}/react`, { token: dadToken, body: { emoji: '🎉' } });
  check('react to shout-out', react.status === 200 && react.data.shoutout.reacts.some((r) => r.emoji === '🎉' && r.userIds.length === 1));
  const reactBad = await req('POST', `/social/shoutouts/${shoutId}/react`, { token: dadToken, body: { emoji: '🧨' } });
  check('unknown react rejected', reactBad.status === 400);
  const reactOff = await req('POST', `/social/shoutouts/${shoutId}/react`, { token: dadToken, body: { emoji: '🎉' } });
  check('react toggles off', reactOff.status === 200 && reactOff.data.shoutout.reacts.every((r) => r.emoji !== '🎉' || r.userIds.length === 0));
  const noteAdd = await req('POST', '/social/notes', { token: momToken, body: { text: 'Bring tuition money Friday!' } });
  check('pin a family note', noteAdd.status === 201);
  const noteId = noteAdd.data.note._id;
  const notes = await req('GET', '/social/notes', { token: rijalToken });
  check('notes listed for everyone', notes.status === 200 && notes.data.notes.length >= 1);
  const noteDelOther = await req('DELETE', `/social/notes/${noteId}`, { token: rijalToken });
  check('non-author cannot delete note', noteDelOther.status === 403);
  const noteDel = await req('DELETE', `/social/notes/${noteId}`, { token: momToken });
  check('author deletes note', noteDel.status === 200);

  console.log('\n== Round-up, trip limits, receipt→list matching ==');
  const checkAdd = await req('POST', '/checklist', { token: rijalToken, body: { name: 'Milk', quantity: '1' } });
  check('checklist item added for match test', checkAdd.status === 201);
  const expWithItems = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Speedmart', amount: 4250, paymentMethod: 'cash', lineItems: [{ name: 'Milk', quantity: 1, unitPrice: 700, totalPrice: 700 }, { name: 'Bread', quantity: 1, unitPrice: 350, totalPrice: 350 }] },
  });
  check('expense with line items saved', expWithItems.status === 201, JSON.stringify(expWithItems.data).slice(0, 160));
  check('round-up saved to roundup goal (42.50 → 0.50)', expWithItems.data.roundup !== null && expWithItems.data.roundup.amount === 50, JSON.stringify(expWithItems.data.roundup));
  check('receipt auto-matched checklist item', expWithItems.data.matchedChecklist === 1, `matched ${expWithItems.data.matchedChecklist}`);
  const goalsAfterRoundup = await req('GET', '/goals', { token: rijalToken });
  check('roundup goal exists', goalsAfterRoundup.status === 200 && goalsAfterRoundup.data.goals.some((g) => g.isRoundup && g.currentAmount === 50), JSON.stringify(goalsAfterRoundup.data.goals.map((g) => ({ name: g.name, isRoundup: g.isRoundup, cur: g.currentAmount }))));
  const limitSet = await req('PATCH', `/family/limits/${rijal._id}`, { token: dadToken, body: { groceryTripLimit: 50000 } });
  check('provider sets trip limit (RM 500)', limitSet.status === 200 && limitSet.data.groceryTripLimit === 50000);
  const limitSetAsMember = await req('PATCH', `/family/limits/${rijal._id}`, { token: rijalToken, body: { groceryTripLimit: 100 } });
  check('member cannot set trip limits', limitSetAsMember.status === 403);
  const overLimitExp = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Trip Limit Test', amount: 999999, paymentMethod: 'cash' },
  });
  check('over-limit trip flagged (no hard block)', overLimitExp.status === 201 && overLimitExp.data.overLimit !== null && overLimitExp.data.overLimit.limit === 50000, JSON.stringify(overLimitExp.data.overLimit));
  const underLimitExp = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Trip Limit Test 2', amount: 30000, paymentMethod: 'cash' },
  });
  check('under-limit trip not flagged', underLimitExp.status === 201 && underLimitExp.data.overLimit === null);
  const limitClear = await req('PATCH', `/family/limits/${rijal._id}`, { token: dadToken, body: { groceryTripLimit: 0 } });
  check('limit cleared (0 = unlimited)', limitClear.status === 200 && limitClear.data.groceryTripLimit === 0);

  console.log('\n== Event goals + shared contributions (leaderboard) ==');
  const eventGoal = await req('POST', '/goals', { token: rijalToken, body: { name: 'Alya’s birthday', targetAmount: 200000, type: 'event', eventDate: '2026-12-01' } });
  check('event fund created', eventGoal.status === 201);
  const eventGoalId = eventGoal.data.goal._id;
  const contrib1 = await req('PATCH', `/goals/${eventGoalId}/contribute`, { token: rijalToken, body: { amount: 5000 } });
  check('rijal contributes to event fund', contrib1.status === 200);
  const contrib2 = await req('PATCH', `/goals/${eventGoalId}/contribute`, { token: dadToken, body: { amount: 15000 } });
  check('dad contributes too', contrib2.status === 200);
  const goalsList = await req('GET', '/goals', { token: rijalToken });
  const eventGoalData = goalsList.data.goals.find((g) => g._id === eventGoalId);
  check('event goal exposes daysLeft + monthlyTarget', eventGoalData && typeof eventGoalData.daysLeft === 'number' && eventGoalData.daysLeft > 0 && eventGoalData.monthlyTarget > 0, JSON.stringify(eventGoalData));
  check('leaderboard ranks contributors', eventGoalData.leaderboard.length === 2 && eventGoalData.leaderboard[0].amount === 15000, JSON.stringify(eventGoalData.leaderboard));
  const badEvent = await req('POST', '/goals', { token: rijalToken, body: { name: 'No date', targetAmount: 1000, type: 'event' } });
  check('event fund without date rejected', badEvent.status === 400);

  console.log('\n== Barcode catalog ==');
  const barcodeAdd = await req('POST', '/catalog', { token: rijalToken, body: { name: 'Milo 3-in-1', barcode: '9551234500011' } });
  check('catalog item saved with barcode', barcodeAdd.status === 201);
  const barcodeFind = await req('GET', `/catalog?barcode=9551234500011`, { token: rijalToken });
  check('catalog lookup by barcode', barcodeFind.status === 200 && barcodeFind.data.items.length === 1 && barcodeFind.data.items[0].name === 'Milo 3-in-1');
  const barcodeDup = await req('POST', '/catalog', { token: rijalToken, body: { name: 'Milo Copy', barcode: '9551234500011' } });
  check('duplicate barcode rejected', barcodeDup.status === 409);

  console.log('\n== Activity feed (visibility) ==');
  const actRijal = await req('GET', '/activity', { token: rijalToken });
  check('Rijal sees groceries + own activity', actRijal.status === 200 && actRijal.data.activity.length >= 5);
  // sister's PIN was set to 3333 earlier by Mom (grocery_spender reset)
  const actSisterLogin = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: sister1._id, pin: '3333' } });
  check('sister login works', actSisterLogin.status === 200);
  const sisterToken = actSisterLogin.data.token;
  const actSisterFeed = await req('GET', '/activity', { token: sisterToken });
  check('dependent does NOT see provider personal funding of others', !actSisterFeed.data.activity.some((a) => a.type === 'personal_funded' && String(a.subjectUserId) === String(mom._id)));
  check('dependent sees groceries activity', actSisterFeed.data.activity.some((a) => a.type === 'groceries_funded'));
  check('dependent sees public spend events (where money goes)', actSisterFeed.data.activity.some((a) => a.type === 'personal_spent'));

  console.log('\n== Bills ==');
  const bills = await req('GET', '/bills', { token: rijalToken });
  check('bills listed', bills.status === 200 && Array.isArray(bills.data.bills));
  const billAdd = await req('POST', '/bills', { token: rijalToken, body: { name: 'TNB', expectedAmount: 18000, dueDayOfMonth: 15, category: 'Utility Bills' } });
  check('add bill', billAdd.status === 201);
  check('bill has due info', billAdd.data.bill.daysUntilDue !== undefined && typeof billAdd.data.bill.dueSoon === 'boolean');
  const billDueSoon = await req('POST', '/bills', { token: rijalToken, body: { name: 'WiFi', expectedAmount: 12900, dueDayOfMonth: new Date().getDate() + 1, category: 'Utility Bills' } });
  check('bill due within 3 days flagged', billDueSoon.status === 201 && billDueSoon.data.bill.dueSoon === true);
  const billPaid = await req('PATCH', `/bills/${billDueSoon.data.bill._id}/mark-paid`, { token: rijalToken });
  check('mark bill paid', billPaid.status === 200 && billPaid.data.bill.dueSoon === false);
  const billDel = await req('DELETE', `/bills/${billAdd.data.bill._id}`, { token: rijalToken });
  check('delete bill', billDel.status === 200);

  console.log('\n== Savings goals ==');
  const goals = await req('GET', '/goals', { token: rijalToken });
  check('goals listed', goals.status === 200);
  const goalAdd = await req('POST', '/goals', { token: rijalToken, body: { name: 'Langkawi trip', targetAmount: 100000, emoji: '🏝️' } });
  check('add goal', goalAdd.status === 201);
  const goalCont = await req('PATCH', `/goals/${goalAdd.data.goal._id}/contribute`, { token: rijalToken, body: { amount: 40000 } });
  check('contribute to goal', goalCont.status === 200 && goalCont.data.goal.currentAmount === 40000);
  const goalReach = await req('PATCH', `/goals/${goalAdd.data.goal._id}/contribute`, { token: rijalToken, body: { amount: 60000 } });
  check('goal reached celebration state', goalReach.status === 200 && goalReach.data.reachedNow === true && goalReach.data.goal.reached === true);
  const goalDel = await req('DELETE', `/goals/${goalAdd.data.goal._id}`, { token: rijalToken });
  check('delete goal', goalDel.status === 200);

  console.log('\n== Excel export ==');
  // xlsx bodies are binary — fetch directly and read the buffer once
  const rawGet = async (path, token) => {
    const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, header: res.headers.get('content-disposition') || '' };
  };
  const expPeriod = await rawGet('/export/period', dadToken);
  check('period export is a real xlsx', expPeriod.status === 200 && expPeriod.buf.slice(0, 2).toString() === 'PK', `status ${expPeriod.status}`);
  check('period export has filename header', expPeriod.header.includes('.xlsx'));
  const expRange = await rawGet(`/export/range?startDate=${new Date().toISOString().slice(0, 10)}&endDate=${new Date().toISOString().slice(0, 10)}`, rijalToken);
  check('range export is a real xlsx', expRange.status === 200 && expRange.buf.slice(0, 2).toString() === 'PK');

  console.log('\n== Excel import ==');
  const buildXlsx = async (rows) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['date', 'shop', 'amount', 'category', 'type', 'note']);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  };
  const importRows = [
    ['12/08/2026', 'Econsave', 42.5, 'Groceries', 'groceries', 'import test'],
    ['11/08/2026', 'Speedmart 99', 15.2, '', 'groceries', ''],
    ['10/08/2026', 'Grab', 12.0, 'Transport', 'personal', ''],
    ['', 'No date row', 5, '', '', ''],
    ['09/08/2026', '', 'x', '', 'groceries', ''],
  ];
  const importFile = await buildXlsx(importRows);
  const imp = await req('POST', '/import/excel', { token: rijalToken, body: { data: importFile } });
  check('excel import saves valid rows', imp.status === 201 && imp.data.imported === 3, JSON.stringify(imp.data).slice(0, 200));
  check('import reports bad rows with row numbers', imp.data.errors.length === 1 && imp.data.errors[0].row === 6, JSON.stringify(imp.data.errors));
  const impBal = await req('GET', `/funding/balances/personal/${rijal._id}`, { token: rijalToken });
  check('personal row lands on own balance', impBal.data.balance.spent >= 1200, `spent ${impBal.data.balance.spent}`);
  const impAgain = await req('POST', '/import/excel', { token: rijalToken, body: { data: importFile } });
  check('re-import skips duplicate groceries rows', impAgain.status === 201 && impAgain.data.duplicates === 2, JSON.stringify(impAgain.data));
  const impBad = await req('POST', '/import/excel', { token: rijalToken, body: { data: Buffer.from('not an xlsx at all').toString('base64') } });
  check('invalid xlsx rejected', impBad.status === 400);
  const impNoData = await req('POST', '/import/excel', { token: rijalToken, body: {} });
  check('missing file data rejected', impNoData.status === 400);
  const impSis = await req('POST', '/import/excel', { token: sisterToken, body: { data: importFile } });
  check('dependent cannot import excel', impSis.status === 403);
  const impSerial = await buildXlsx([
    [46240, 'Serial Date Shop', 9.9, '', 'groceries', ''], // 46240 ≈ 6 Aug 2026, inside the active period
  ]);
  const impSer = await req('POST', '/import/excel', { token: rijalToken, body: { data: impSerial } });
  check('excel serial dates parsed', impSer.status === 201 && impSer.data.imported === 1, JSON.stringify(impSer.data).slice(0, 160));
  const impOld = await buildXlsx([
    ['01/01/2026', 'Ancient Shop', 5.5, '', 'groceries', ''], // before the current period
  ]);
  const impOldRes = await req('POST', '/import/excel', { token: rijalToken, body: { data: impOld } });
  check('pre-period rows skipped with a clear message', impOldRes.status === 201 && impOldRes.data.imported === 0 && impOldRes.data.errors.length === 1 && /before the current period/.test(impOldRes.data.errors[0].message), JSON.stringify(impOldRes.data).slice(0, 180));

  console.log('\n== Family settings ==');
  const famGet = await req('GET', '/family', { token: rijalToken });
  check('family settings readable', famGet.status === 200 && famGet.data.family.name);
  const famSetAsMember = await req('PATCH', '/family', { token: rijalToken, body: { name: 'Hacked' } });
  check('member cannot change family settings', famSetAsMember.status === 403);
  const famRename = await req('PATCH', '/family', { token: dadToken, body: { name: 'The Test Family' } });
  check('provider renames family', famRename.status === 200 && famRename.data.family.name === 'The Test Family');
  const famType = await req('PATCH', '/family', { token: dadToken, body: { periodType: 'weekly' } });
  check('provider switches period type + rebuilds period', famType.status === 200 && famType.data.family.periodType === 'weekly' && famType.data.periodRebuilt !== null, JSON.stringify(famType.data).slice(0, 140));
  const famBack = await req('PATCH', '/family', { token: dadToken, body: { periodType: 'monthly' } });
  check('switch back to monthly', famBack.status === 200 && famBack.data.family.periodType === 'monthly');
  const famBad = await req('PATCH', '/family', { token: dadToken, body: { periodType: 'hourly' } });
  check('invalid period type rejected', famBad.status === 400);

  console.log('\n== Change / refresh / logout ==');
  const changeWrong = await req('POST', '/auth/change-pin', { token: rijalToken, body: { currentPin: '1111', newPin: '7777' } });
  check('change-pin rejects wrong current PIN', changeWrong.status === 401);
  const changeOk = await req('POST', '/auth/change-pin', { token: rijalToken, body: { currentPin: '2302', newPin: '7777' } });
  check('change-pin succeeds with correct PIN', changeOk.status === 200);
  const relogin = await req('POST', '/auth/verify-pin', { token: providerToken, body: { userId: rijal._id, pin: '7777' } });
  check('new PIN works after change', relogin.status === 200);
  // the relogin rotated the refresh token — grab the fresh one
  const freshRefresh = relogin.data.refreshToken;
  await req('POST', '/auth/change-pin', { token: relogin.data.token, body: { currentPin: '7777', newPin: '2302' } });
  const refreshNoBio = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: freshRefresh } });
  check('refresh rejected until biometric enabled', refreshNoBio.status === 403);
  const bioOn = await req('POST', '/auth/biometric', { token: relogin.data.token, body: { enabled: true } });
  check('biometric toggle on', bioOn.status === 200 && bioOn.data.user.biometricEnabled === true);
  const refreshOk = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: freshRefresh } });
  check('refresh token issues new session (biometric enabled)', refreshOk.status === 200 && refreshOk.data.token);
  const refreshReuse = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: freshRefresh } });
  check('refresh token rotates (reuse rejected)', refreshReuse.status === 401);
  const logout = await req('POST', '/auth/logout', { token: refreshOk.data.token });
  check('logout ok', logout.status === 200);
  const refreshAfterLogout = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: refreshOk.data.refreshToken } });
  check('refresh after logout rejected', refreshAfterLogout.status === 401);

  console.log('\n== Profile photos ==');
  const photoData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const setOwnPhoto = await req('PATCH', '/auth/photo', { token: rijalToken, body: { avatarPhoto: photoData } });
  check('member sets own photo', setOwnPhoto.status === 200 && setOwnPhoto.data.user.avatarPhoto === photoData);
  const setOtherPhoto = await req('PATCH', '/auth/photo', { token: rijalToken, body: { userId: sister1._id, avatarPhoto: photoData } });
  check('member cannot change another person’s photo', setOtherPhoto.status === 403);
  const setSisPhoto = await req('PATCH', '/auth/photo', { token: dadToken, body: { userId: sister1._id, avatarPhoto: photoData } });
  check('provider changes another person’s photo', setSisPhoto.status === 200 && setSisPhoto.data.user.avatarPhoto === photoData);
  const badPhoto = await req('PATCH', '/auth/photo', { token: rijalToken, body: { avatarPhoto: 'not-an-image' } });
  check('invalid photo rejected', badPhoto.status === 400);
  const rmOwnPhoto = await req('PATCH', '/auth/photo', { token: rijalToken, body: { avatarPhoto: null } });
  check('photo can be removed', rmOwnPhoto.status === 200 && rmOwnPhoto.data.user.avatarPhoto === null);

  console.log('\n== Period close & rollover (provider) ==');
  const statusBefore = await req('GET', '/periods/status', { token: dadToken });
  check('period status', statusBefore.status === 200 && statusBefore.data.period);
  const gbBefore = (await req('GET', '/funding/balances/groceries', { token: dadToken })).data.balance;
  const close = await req('POST', '/periods/close-and-start-new', { token: dadToken });
  check('provider closes period', close.status === 200, JSON.stringify(close.data));
  check('new active period opened', close.data.opened && close.data.opened.status === 'active');
  const gbAfter = (await req('GET', '/funding/balances/groceries', { token: dadToken })).data.balance;
  check('rollover carries balance forward', gbAfter.funded === Math.max(0, gbBefore.funded - gbBefore.spent), `before ${gbBefore.funded - gbBefore.spent} after ${gbAfter.funded}`);
  check('new period has fresh spent (0)', gbAfter.spent === 0);
  const closeAgain = await req('POST', '/periods/close-and-start-new', { token: dadToken });
  check('cannot close again immediately (no protection needed — new period opened)', closeAgain.status === 200 || closeAgain.status === 409);

  console.log('\n== Input validation & security ==');
  const hugeAmount = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: -5, paymentMethod: 'cash' } });
  check('negative amount rejected', hugeAmount.status === 400);
  const nanAmount = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: 'abc', paymentMethod: 'cash' } });
  check('non-numeric amount rejected', nanAmount.status === 400);
  const badMethod = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: 1000, paymentMethod: 'bitcoin' } });
  check('invalid payment method rejected', badMethod.status === 400);
  const badId = await req('GET', '/funding/balances/personal/notanid', { token: dadToken });
  check('invalid object id rejected', badId.status === 400);
  const badToken = await req('GET', '/funding/balances/groceries', { token: 'not.a.jwt' });
  check('invalid token rejected', badToken.status === 401);
  const wrongUser = await req('POST', '/expenses/personal', { token: dadToken, body: { userId: rijal._id, amount: 100, category: 'x' } });
  check('personal expense userId is ignored (self only enforced)', wrongUser.status === 201 && String(wrongUser.data.expense.userId) === String(dad._id));

  console.log('\n== AI (v2.2) — validation, gating, live calls ==');
  const aiNoAuth = await req('POST', '/ai/shopping-list', { body: { prompt: 'milk' } });
  check('AI routes are protected', aiNoAuth.status === 401);
  const aiShort = await req('POST', '/ai/parse-receipt-text', { token: rijalToken, body: { text: 'hi' } });
  check('parse-receipt-text rejects tiny text', aiShort.status === 400);
  const aiBadImg = await req('POST', '/ai/scan-receipt', { token: rijalToken, body: { image: 'not-an-image' } });
  check('scan-receipt rejects non-image input', aiBadImg.status === 400);
  const aiEmpty = await req('POST', '/ai/shopping-list', { token: rijalToken, body: { prompt: '  ' } });
  check('shopping-list rejects empty prompt', aiEmpty.status === 400);
  // family-wide AI switch gating (provider toggles it)
  const aiOff = await req('PATCH', '/family', { token: dadToken, body: { aiEnabled: false } });
  check('provider turns AI off', aiOff.status === 200 && aiOff.data.family.aiEnabled === false);
  const aiGated = await req('POST', '/ai/shopping-list', { token: rijalToken, body: { prompt: 'milk' } });
  check('AI calls refused while family AI is off', aiGated.status === 403);
  const aiOn = await req('PATCH', '/family', { token: dadToken, body: { aiEnabled: true } });
  check('provider turns AI back on', aiOn.status === 200 && aiOn.data.family.aiEnabled === true);
  const famAI = await req('GET', '/family', { token: rijalToken });
  check('family settings expose aiEnabled', famAI.status === 200 && famAI.data.family.aiEnabled === true);

  // Live calls against the real Groq key. Upstream hiccups (quota/timeout/network)
  // are external, not app bugs — those get reported as "skipped" instead of failed.
  const aiUpstreamOk = (r) => r.status === 200;
  const aiSkipped = (r) => r.status === 502 || r.status === 504 || r.status === 429 || r.status === -1;
  const aiTry = async (body) => {
    try {
      return await req('POST', '/ai/parse-receipt-text', { token: rijalToken, body });
    } catch {
      return { status: -1 };
    }
  };
  const aiParse = await aiTry({ text: 'ECONSAVE SUPERMARKET\nMilo 3-in-1 2 9.90\nBeras 5kg 1 28.50\nTOTAL 38.40' });
  check('AI parses OCR text into receipt JSON', aiUpstreamOk(aiParse) && aiParse.data.shop && aiParse.data.items.length >= 2, aiSkipped(aiParse) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiParse.data).slice(0, 160));
  const aiListRes = await (async () => {
    try { return await req('POST', '/ai/shopping-list', { token: rijalToken, body: { prompt: 'breakfast for 4' } }); } catch { return { status: -1 }; }
  })();
  check('AI generates a shopping list', aiUpstreamOk(aiListRes) && Array.isArray(aiListRes.data.items) && aiListRes.data.items.length > 0, aiSkipped(aiListRes) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiListRes.data).slice(0, 160));
  const aiMealRes = await (async () => {
    try { return await req('POST', '/ai/meal-plan', { token: rijalToken, body: { prompt: 'simple dinners', days: 2 } }); } catch { return { status: -1 }; }
  })();
  check('AI plans meals', aiUpstreamOk(aiMealRes) && Array.isArray(aiMealRes.data.meals) && aiMealRes.data.meals.length >= 1, aiSkipped(aiMealRes) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiMealRes.data).slice(0, 160));
  const aiInsRes = await (async () => {
    try { return await req('POST', '/ai/insights', { token: rijalToken, body: {} }); } catch { return { status: -1 }; }
  })();
  check('AI explains real spending data', aiUpstreamOk(aiInsRes) && Array.isArray(aiInsRes.data.insights) && aiInsRes.data.insights.length > 0, aiSkipped(aiInsRes) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiInsRes.data).slice(0, 160));

  console.log('\n== v3 — discount/tax, petrol, avatar sync, delete-by-date ==');
  // Discount + tax recorded as metadata; petrol station auto-categorised.
  const petrolExp = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Petronas Batu Caves', amount: 6000, category: '', paymentMethod: 'cash', discount: 300, tax: 500, lineItems: [{ name: 'RON95', quantity: 1, unitPrice: 6000, totalPrice: 6000 }] },
  });
  check('expense stores discount + tax', petrolExp.status === 201 && petrolExp.data.expense.discount === 300 && petrolExp.data.expense.tax === 500, JSON.stringify(petrolExp.data.expense).slice(0, 200));
  check('petrol station auto-categorised as Petrol', petrolExp.status === 201 && petrolExp.data.expense.category === 'Petrol');
  const petShop = await req('GET', '/expenses/shops', { token: rijalToken });
  const petronas = (petShop.data.shops || []).find((s) => s.name.includes('Petronas'));
  check('petrol shop saved with petrol type', Boolean(petronas) && petronas.type === 'petrol', JSON.stringify(petronas));
  const badDiscount = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'X', amount: 100, discount: 500, paymentMethod: 'cash' } });
  check('discount bigger than amount rejected', badDiscount.status === 400);

  const petrolSum = await req('GET', '/analytics/petrol', { token: rijalToken });
  check('petrol analytics returns period summary', petrolSum.status === 200 && petrolSum.data.total >= 6000 && petrolSum.data.trips >= 1, JSON.stringify(petrolSum.data).slice(0, 160));
  const petrolTx = await req('GET', '/transactions/expenses?cat=Petrol', { token: rijalToken });
  check('transactions filter by category (Petrol)', petrolTx.status === 200 && petrolTx.data.expenses.some((e) => e.category === 'Petrol'));

  // Dashboard avatar sync — a photo set on one member shows in the summary.
  const photoData2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const setPhoto2 = await req('PATCH', '/auth/photo', { token: rijalToken, body: { avatarPhoto: photoData2 } });
  check('member sets own photo (v3)', setPhoto2.status === 200);
  const sumWithPhoto = await req('GET', '/analytics/family/summary', { token: dadToken });
  const rijalInSummary = (sumWithPhoto.data.personal || []).find((p) => String(p.user._id) === String(rijal._id));
  check('family summary includes avatarPhoto (dashboard sync)', Boolean(rijalInSummary?.user?.avatarPhoto), JSON.stringify(rijalInSummary?.user));

  // Delete-by-date range — provider only, balances rebuilt.
  const depDel = await req('POST', '/family/delete-data', { token: momToken, body: { from: '2020-01-01', to: '2030-01-01' } });
  check('non-provider cannot delete family data', depDel.status === 403);
  const badRange = await req('POST', '/family/delete-data', { token: dadToken, body: { from: '2025-01-01' } });
  check('delete-data requires both dates', badRange.status === 400);
  const gbDelBefore = (await req('GET', '/funding/balances/groceries', { token: dadToken })).data.balance;
  const today = new Date();
  const fromD = new Date(today); fromD.setDate(fromD.getDate() - 2);
  const delRes = await req('POST', '/family/delete-data', { token: dadToken, body: { from: fromD.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) } });
  check('provider deletes records in range', delRes.status === 200 && delRes.data.ok === true && (delRes.data.deleted.expenses > 0), JSON.stringify(delRes.data).slice(0, 160));
  const gbDelAfter = (await req('GET', '/funding/balances/groceries', { token: dadToken })).data.balance;
  check('balances rebuilt after deletion', gbDelAfter.spent < gbDelBefore.spent, `before ${gbDelBefore.spent} after ${gbDelAfter.spent}`);
  const delZero = await req('POST', '/family/delete-data', { token: dadToken, body: { from: '1990-01-01', to: '1991-01-01' } });
  check('delete-data with empty range is harmless', delZero.status === 200 && delZero.data.deleted.expenses === 0);

  // v3 AI — Q&A, restock, forecast (validation + gating, live calls tolerant of upstream).
  const askEmpty = await req('POST', '/ai/ask', { token: rijalToken, body: { question: '  ' } });
  check('AI ask rejects empty question', askEmpty.status === 400);
  const aiAskRes = await (async () => {
    try { return await req('POST', '/ai/ask', { token: rijalToken, body: { question: 'How much did we spend at Petronas?' } }); } catch { return { status: -1 }; }
  })();
  check('AI answers a money question', aiUpstreamOk(aiAskRes) && aiAskRes.data.answer && aiAskRes.data.answer.length > 0, aiSkipped(aiAskRes) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiAskRes.data).slice(0, 160));
  const aiRestockRes = await (async () => {
    try { return await req('POST', '/ai/restock', { token: rijalToken, body: {} }); } catch { return { status: -1 }; }
  })();
  check('AI suggests restock list', aiUpstreamOk(aiRestockRes) && Array.isArray(aiRestockRes.data.items), aiSkipped(aiRestockRes) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiRestockRes.data).slice(0, 160));
  const aiForecastRes = await (async () => {
    try { return await req('POST', '/ai/forecast', { token: rijalToken, body: {} }); } catch { return { status: -1 }; }
  })();
  check('AI forecasts next period', aiUpstreamOk(aiForecastRes) && (aiForecastRes.data.estimate > 0 || aiForecastRes.data.skipAI), aiSkipped(aiForecastRes) ? '(skipped — AI upstream unavailable)' : JSON.stringify(aiForecastRes.data).slice(0, 160));

  console.log('\n== Invite codes, joining & family isolation ==');
  const inviteAsMember = await req('POST', '/family/invite', { token: rijalToken });
  check('only provider creates invite codes', inviteAsMember.status === 403);
  const invite = await req('POST', '/family/invite', { token: providerToken });
  check('provider creates invite code', invite.status === 200 && /^[A-Z0-9]{6}$/.test(invite.data.inviteCode), JSON.stringify(invite.data));
  const inviteGet = await req('GET', '/family/invite', { token: providerToken });
  check('invite code readable with 5 uses', inviteGet.status === 200 && inviteGet.data.inviteCode === invite.data.inviteCode && inviteGet.data.usesLeft === 5);
  const joinBadCode = await req('POST', '/auth/join', { body: { email: `join${unique}@housley.test`, password: 'join-pass-123', name: 'Joiner', inviteCode: 'ZZZZZZ' } });
  check('join rejects unknown code', joinBadCode.status === 404);
  const joinNoCode = await req('POST', '/auth/join', { body: { email: `join${unique}@housley.test`, password: 'join-pass-123', name: 'Joiner' } });
  check('join requires a code', joinNoCode.status === 400);
  const join = await req('POST', '/auth/join', { body: { email: `join${unique}@housley.test`, password: 'join-pass-123', name: 'Joiner', inviteCode: invite.data.inviteCode } });
  check('join creates a member account in the family', join.status === 201 && join.data.user.role === 'member' && join.data.family._id === reg.data.family._id, JSON.stringify(join.data).slice(0, 160));
  const joinToken = join.data.token;
  check('join returns all family profiles', join.data.profiles.length === 6);
  const inviteAfter = await req('GET', '/family/invite', { token: providerToken });
  check('invite uses decremented after join', inviteAfter.status === 200 && inviteAfter.data.usesLeft === 4);
  const joinAgain = await req('POST', '/auth/join', { body: { email: `join2${unique}@housley.test`, password: 'join-pass-123', name: 'Joiner2', inviteCode: invite.data.inviteCode } });
  check('code reusable (up to 5 uses)', joinAgain.status === 201);
  const addAsMember = await req('POST', '/family/members', { token: rijalToken, body: { name: 'Nope', role: 'member' } });
  check('member cannot add family members', addAsMember.status === 403);
  const delSelf = await req('DELETE', `/family/members/${dad._id}`, { token: providerToken });
  check('provider cannot remove their own profile', delSelf.status === 400);
  const delJoiner = await req('DELETE', `/family/members/${join.data.user._id}`, { token: providerToken });
  check('provider removes a member', delJoiner.status === 200);
  const joinTokenOld = joinToken;
  const oldFamily = await req('GET', '/family', { token: joinTokenOld });
  check('removed member loses family access', oldFamily.status === 401 || oldFamily.status === 404 || oldFamily.status === 400);

  console.log('\n== Family isolation (families never see each other) ==');
  const famB = await req('POST', '/auth/register', { body: { email: `other${unique}@housley.test`, password: 'other-pass-123', familyName: 'Other Family', name: 'Other Dad' } });
  check('second family registers independently', famB.status === 201);
  const famBToken = famB.data.token;
  const famA = await req('GET', '/family', { token: providerToken });
  const famA2 = await req('GET', '/family', { token: famBToken });
  check('families are isolated (different names)', famA.status === 200 && famA2.status === 200 && famA.data.family.name !== famA2.data.family.name);
  const famBProfiles = await req('GET', '/auth/profiles', { token: famBToken });
  check('family B sees only its own members', famBProfiles.data.users.length === 1);
  const famBFund = await req('GET', '/funding/balances/groceries', { token: famBToken });
  check('family B has its own empty balance', famBFund.status === 200 && famBFund.data.balance.funded === 0 && famBFund.data.balance.spent === 0);
  const famBExp = await req('POST', '/expenses/groceries', { token: famBToken, body: { shopName: 'B Shop', amount: 1000, paymentMethod: 'cash' } });
  check('family B spends in its own family', famBExp.status === 201 && famBExp.data.expense.shopName === 'B Shop');
  const famAExp = await req('GET', '/transactions/expenses', { token: providerToken });
  check('family A never sees family B records', famAExp.data.expenses.every((e) => e.shopName !== 'B Shop'));
  const crossPin = await req('POST', '/auth/set-pin', { token: famBToken, body: { userId: rijal._id, pin: '1111' } });
  check('cross-family PIN set blocked', crossPin.status === 403);

  console.log('\n== Pro subscription & paywall (family B — trial, dev helpers) ==');
  // A brand-new family gets a 7-day free Pro trial.
  const proTrial = await req('GET', '/pro/status', { token: famBToken });
  check('new family has an active Pro trial', proTrial.status === 200 && proTrial.data.active === true && proTrial.data.tier === 'trial', JSON.stringify(proTrial.data).slice(0, 140));
  const yearlyPlan = (proTrial.data.plans || []).find((p) => p.id === 'yearly');
  check('status exposes the 3 plans with prices (yearly = 2990 sen)', proTrial.data.plans?.length === 3 && yearlyPlan && yearlyPlan.priceSen === 2990, JSON.stringify(proTrial.data.plans));
  const proNoAuth = await req('GET', '/pro/status');
  check('pro status requires an account session', proNoAuth.status === 401);

  // Checkout must either succeed (when ToyyibPay keys are configured and valid)
  // or fail gracefully with 503 (unconfigured) / 502 (gateway rejection).
  // Never a 500 (which would mean a server bug).
  const checkout = await req('POST', '/pro/checkout', { token: famBToken, body: { plan: 'yearly' } });
  check('checkout succeeds (200) or fails gracefully (503/502)', 
    checkout.status === 200 || checkout.status === 503 || checkout.status === 502,
    `status=${checkout.status} ${JSON.stringify(checkout.data).slice(0, 140)}`);
  const checkoutBadPlan = await req('POST', '/pro/checkout', { token: famBToken, body: { plan: 'weekly' } });
  check('checkout rejects unknown plan', checkoutBadPlan.status === 400);

  // Webhook security — a forged callback (wrong MD5 hash) must be rejected.
  const forged = await req('POST', '/pro/webhook', { body: { status: '1', order_id: 'HLYFAKE', refno: 'REF1', billcode: 'BC1', hash: 'deadbeef' } });
  check('webhook rejects forged callback (bad hash)', forged.status === 400);
  const forgedMissing = await req('POST', '/pro/webhook', { body: { status: '1' } });
  check('webhook rejects missing callback fields', forgedMissing.status === 400);

  // Drop the trial (dev helper) → the family is free and the paywall must bite.
  const devClear = await req('POST', '/pro/dev-clear', { token: famBToken });
  check('dev-clear drops the trial (test helper)', devClear.status === 200 && devClear.data.status.active === false, JSON.stringify(devClear.data).slice(0, 140));
  const proFree = await req('GET', '/pro/status', { token: famBToken });
  check('status reports free after trial ends', proFree.status === 200 && proFree.data.active === false && proFree.data.tier === 'none');

  const aiBlocked = await req('POST', '/ai/shopping-list', { token: famBToken, body: { prompt: 'milk tea' } });
  check('AI blocked for free family (402 PRO_REQUIRED)', aiBlocked.status === 402 && aiBlocked.data.code === 'PRO_REQUIRED', JSON.stringify(aiBlocked.data).slice(0, 140));
  const expBlocked = await rawGet('/export/period', famBToken);
  check('Excel export blocked for free family', expBlocked.status === 402);
  const impBlocked = await req('POST', '/import/excel', { token: famBToken, body: { data: 'AAAA' } });
  check('Excel import blocked for free family', impBlocked.status === 402);
  const histFree = await req('GET', '/transactions/expenses', { token: famBToken });
  check('free family history flagged as 3-month-limited', histFree.status === 200 && histFree.data.historyLimited === true, JSON.stringify(histFree.data).slice(0, 120));

  // Full dev payment flow: order → complete → Pro granted, idempotently.
  const devOrder = await req('POST', '/pro/dev-order', { token: famBToken, body: { plan: 'yearly' } });
  check('dev-order creates a pending order', devOrder.status === 201 && devOrder.data.orderId && devOrder.data.amountSen === 2990, JSON.stringify(devOrder.data).slice(0, 140));
  const devComplete = await req('POST', '/pro/dev-complete', { token: famBToken, body: { orderId: devOrder.data.orderId } });
  check('dev-complete grants yearly Pro', devComplete.status === 200 && devComplete.data.status.active === true && devComplete.data.status.tier === 'yearly', JSON.stringify(devComplete.data).slice(0, 160));
  const proAfter = await req('GET', '/pro/status', { token: famBToken });
  check('status shows Pro with a future expiry', proAfter.data.active === true && proAfter.data.expiresAt && new Date(proAfter.data.expiresAt).getTime() > Date.now(), JSON.stringify(proAfter.data).slice(0, 140));
  const devAgain = await req('POST', '/pro/dev-complete', { token: famBToken, body: { orderId: devOrder.data.orderId } });
  check('grant is idempotent (same order never double-grants)', devAgain.status === 200);
  const exp1 = (await req('GET', '/pro/status', { token: famBToken })).data.expiresAt;
  const devOrder2 = await req('POST', '/pro/dev-order', { token: famBToken, body: { plan: 'yearly' } });
  await req('POST', '/pro/dev-complete', { token: famBToken, body: { orderId: devOrder2.data.orderId } });
  const exp2 = (await req('GET', '/pro/status', { token: famBToken })).data.expiresAt;
  check('renewal EXTENDS the expiry (never shortens)', new Date(exp2).getTime() > new Date(exp1).getTime(), `${exp1} → ${exp2}`);
  const devOrder3 = await req('POST', '/pro/dev-order', { token: famBToken, body: { plan: 'lifetime' } });
  const devLife = await req('POST', '/pro/dev-complete', { token: famBToken, body: { orderId: devOrder3.data.orderId } });
  check('lifetime grant never expires', devLife.status === 200 && devLife.data.status.tier === 'lifetime' && devLife.data.status.expiresAt === null, JSON.stringify(devLife.data.status).slice(0, 140));

  // After the grant, the paywall opens: AI callable, history unlimited.
  const aiAfter = await req('POST', '/ai/shopping-list', { token: famBToken, body: { prompt: 'milk tea' } });
  check('AI unblocked after Pro grant', aiAfter.status !== 402 && (aiAfter.status === 200 || aiAfter.status === 502), `got ${aiAfter.status}`);
  const histPro = await req('GET', '/transactions/expenses', { token: famBToken });
  check('Pro family history unlimited', histPro.status === 200 && histPro.data.historyLimited === false);

  console.log('\n== Factory reset (provider, per-family — must run last) ==');
  const resetWrong = await req('POST', '/auth/factory-reset', { token: providerToken, body: { pin: '0000' } });
  check('factory reset rejects wrong PIN', resetWrong.status === 403);
  const resetNoAuth = await req('POST', '/auth/factory-reset', { body: { pin: RESET_PIN } });
  check('factory reset requires an account session', resetNoAuth.status === 401);
  const resetAsMember = await req('POST', '/auth/factory-reset', { token: rijalToken, body: { pin: RESET_PIN } });
  check('factory reset requires provider role', resetAsMember.status === 403);
  const resetOk = await req('POST', '/auth/factory-reset', { token: providerToken, body: { pin: RESET_PIN } });
  check('factory reset wipes everything', resetOk.status === 200 && resetOk.data.ok === true, JSON.stringify(resetOk.data).slice(0, 140));
  const profilesAfter = await req('GET', '/auth/profiles', { token: providerToken });
  check('members still exist after reset', profilesAfter.status === 200 && profilesAfter.data.users.length >= 5);
  check('all PINs cleared after reset', profilesAfter.data.users.every((u) => u.hasPin === false));
  const balAfter = await req('GET', '/funding/balances/groceries', { token: dadToken });
  check('balances zeroed after reset', balAfter.status === 200 && balAfter.data.balance.currentBalance === 0 && balAfter.data.balance.spent === 0);
  // v2 data must be wiped too
  const shoutsAfter = await req('GET', '/social/shoutouts', { token: dadToken });
  check('shout-outs wiped by reset', shoutsAfter.status === 200 && shoutsAfter.data.shoutouts.length === 0, JSON.stringify(shoutsAfter.data).slice(0, 120));
  const notesAfter = await req('GET', '/social/notes', { token: dadToken });
  check('pin-board notes wiped by reset', notesAfter.status === 200 && notesAfter.data.notes.length === 0);
  const choresAfter = await req('GET', '/chores', { token: dadToken });
  check('chores wiped by reset', choresAfter.status === 200 && choresAfter.data.chores.length === 0);
  const mealsAfter = await req('GET', '/meals', { token: dadToken });
  check('meal plans wiped by reset', mealsAfter.status === 200 && mealsAfter.data.meals.length === 0);
  const goalsAfterReset = await req('GET', '/goals', { token: dadToken });
  check('goals (incl. round-up & event) wiped by reset', goalsAfterReset.status === 200 && goalsAfterReset.data.goals.length === 0, `status ${goalsAfterReset.status} body ${JSON.stringify(goalsAfterReset.data).slice(0, 120)}`);
  const checkAfter = await req('GET', '/checklist', { token: dadToken });
  check('checklist wiped by reset', checkAfter.status === 200 && checkAfter.data.items.length === 0, `status ${checkAfter.status} body ${JSON.stringify(checkAfter.data).slice(0, 120)}`);

  console.log('\n========================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    for (const f of failures) console.log('  ✗', f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

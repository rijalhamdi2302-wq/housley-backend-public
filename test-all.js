/**
 * Housley — comprehensive API test: both Pro and Free accounts.
 * Tests login, profiles, PIN, CRUD, Pro gating, analytics, AI, exports, and more.
 */

const BASE = 'http://localhost:4000';
const results = [];

async function req(method, path, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const opts = { method, headers: h };
  if (body != null && method !== 'GET' && method !== 'HEAD') {
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path, opts);
  } catch (e) {
    return { status: 0, ok: false, data: { error: e.message } };
  }
  const ct = res.headers.get('content-type') || '';
  let data;
  if (ct.includes('json')) data = await res.json();
  else if (ct.includes('pdf') || ct.includes('excel') || ct.includes('octet')) {
    data = { _binary: true, size: Number(res.headers.get('content-length')) || 0 };
  } else data = {};
  return { status: res.status, ok: res.ok, data };
}

function log(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
}

async function login(email, password, label) {
  const r = await req('POST', '/api/auth/login', { email, password });
  log(`${label} login`, r.ok, r.ok ? 'token OK' : `FAIL status=${r.status} ${r.data.error || ''}`);
  return r.ok ? r.data.token : null;
}

async function ensurePin(token, userId, pin, label) {
  if (!userId) {
    log(`${label} PIN (no userId)`, false, 'userId is undefined — cannot test PIN');
    return null;
  }
  // Try verify first
  const v = await req('POST', '/api/auth/verify-pin', { userId, pin }, token);
  if (v.ok) {
    log(`${label} PIN verify`, true, 'user=' + (v.data.user?.name || ''));
    return v.data.token;
  }
  // If 409 (no PIN yet) or 401 (wrong PIN), set it
  if (v.status === 409 || v.status === 401) {
    const s = await req('POST', '/api/auth/set-pin', { userId, pin }, token);
    if (s.ok) {
      log(`${label} set PIN`, true, 'created');
      const v2 = await req('POST', '/api/auth/verify-pin', { userId, pin }, token);
      if (v2.ok) return v2.data.token;
    }
    log(`${label} set PIN`, false, `status=${s.status} ${s.data.error || ''}`);
  }
  log(`${label} PIN verify`, false, `status=${v.status} ${v.data.error || ''}`);
  return null;
}

async function run() {
  console.log('\n========== Housley API Test Suite ==========\n');

  // ==================== PRO ACCOUNT ====================
  console.log('--- PRO ACCOUNT (demo@housley.app / demo1234) ---');
  const proToken = await login('demo@housley.app', 'demo1234', 'Pro');
  if (!proToken) { console.log('FATAL: Pro login failed'); return; }

  // Profiles
  const proProfiles = await req('GET', '/api/auth/profiles', null, proToken);
  log('Pro profiles', proProfiles.ok, 'count=' + (proProfiles.data.users?.length || 0));

  const proProvider = proProfiles.data.users?.find(u => u.role === 'provider');
  const proUser = await ensurePin(proToken, proProvider?._id, '1234', 'Pro');

  // Family settings
  const proFam = await req('GET', '/api/family', null, proToken);
  log('Pro family settings', proFam.ok, 'name=' + proFam.data?.family?.name);

  // Pro status
  const proSt = await req('GET', '/api/pro/status', null, proToken);
  log('Pro status', proSt.ok, `active=${proSt.data?.active} tier=${proSt.data?.tier}`);

  // Categories
  const proCats = await req('GET', '/api/categories', null, proToken);
  log('Pro categories', proCats.ok, 'count=' + (proCats.data?.length || proCats.data?.categories?.length || '?'));

  // Grocery balance
  const proBal = await req('GET', '/api/funding/balances/groceries', null, proToken);
  log('Pro grocery balance', proBal.ok);

  // Period status
  const proPeriod = await req('GET', '/api/periods/status', null, proToken);
  log('Pro period status', proPeriod.ok);

  // Activity
  const proAct = await req('GET', '/api/activity?limit=5', null, proToken);
  log('Pro activity', proAct.ok, 'count=' + (proAct.data?.length || proAct.data?.activities?.length || 0));

  // AI Insights
  const proInsights = await req('POST', '/api/ai/insights', {}, proToken);
  log('Pro AI insights', proInsights.ok, proInsights.ok ? 'ok' : `status=${proInsights.status} ${(proInsights.data.error || '').slice(0, 80)}`);

  // AI Ask
  const proAsk = await req('POST', '/api/ai/ask', { question: 'How much did I spend?' }, proToken);
  log('Pro AI ask', proAsk.ok, proAsk.ok ? 'ok' : `status=${proAsk.status} ${(proAsk.data.error || '').slice(0, 80)}`);

  // AI Forecast
  const proFc = await req('POST', '/api/ai/forecast', {}, proToken);
  log('Pro AI forecast', proFc.ok, proFc.ok ? 'ok' : `status=${proFc.status} ${(proFc.data.error || '').slice(0, 80)}`);

  // AI Restock
  const proRs = await req('POST', '/api/ai/restock', {}, proToken);
  log('Pro AI restock', proRs.ok, proRs.ok ? 'ok' : `status=${proRs.status} ${(proRs.data.error || '').slice(0, 80)}`);

  // Analytics
  const proWeek = await req('GET', '/api/analytics/weekly-recap', null, proToken);
  log('Pro weekly recap', proWeek.ok);
  const proTrend = await req('GET', '/api/analytics/trend?bucket=monthly', null, proToken);
  log('Pro trend analytics', proTrend.ok);
  const proWeekday = await req('GET', '/api/analytics/weekday-pattern', null, proToken);
  log('Pro weekday pattern', proWeekday.ok);
  const proMember = await req('GET', '/api/analytics/member-comparison', null, proToken);
  log('Pro member comparison', proMember.ok);
  const proTop = await req('GET', '/api/analytics/top-expenses', null, proToken);
  log('Pro top expenses', proTop.ok);
  const proTopShops = await req('GET', '/api/analytics/top-shops', null, proToken);
  log('Pro top shops', proTopShops.ok);

  // Invite
  const proInvite = await req('POST', '/api/family/invite', null, proToken);
  log('Pro invite code', proInvite.ok, proInvite.data?.code || '');

  // Export PDF
  const proPdf = await req('GET', '/api/export/period', null, proToken);
  log('Pro PDF export', proPdf.ok, proPdf.data?._binary ? 'binary OK' : `status=${proPdf.status}`);

  // Bills
  const proBills = await req('GET', '/api/bills', null, proToken);
  log('Pro bills', proBills.ok);

  // Goals
  const proGoals = await req('GET', '/api/goals', null, proToken);
  log('Pro goals', proGoals.ok);

  // Meals
  const proMeals = await req('GET', '/api/meals', null, proToken);
  log('Pro meals', proMeals.ok);

  // Chores
  const proChores = await req('GET', '/api/chores', null, proToken);
  log('Pro chores', proChores.ok);

  // Shoutouts
  const proShoutouts = await req('GET', '/api/social/shoutouts', null, proToken);
  log('Pro shoutouts', proShoutouts.ok);

  // Notes
  const proNotes = await req('GET', '/api/social/notes', null, proToken);
  log('Pro notes', proNotes.ok);

  // Checklist
  const proCheck = await req('GET', '/api/checklist', null, proToken);
  log('Pro checklist', proCheck.ok);

  // Catalog
  const proCatList = await req('GET', '/api/catalog', null, proToken);
  log('Pro catalog', proCatList.ok);

  // Shop analysis
  const proCheapest = await req('GET', '/api/expenses/shops/cheapest', null, proToken);
  log('Pro cheapest shop', proCheapest.ok);
  const proFavs = await req('GET', '/api/expenses/shops/favorites', null, proToken);
  log('Pro shop favorites', proFavs.ok);

  // Payment method
  const proPay = await req('GET', '/api/analytics/payment-method', null, proToken);
  log('Pro payment method', proPay.ok);

  // Streak
  const proStreak = await req('GET', '/api/analytics/streak', null, proToken);
  log('Pro streak', proStreak.ok);

  // Badges
  const proBadges = await req('GET', '/api/analytics/badges', null, proToken);
  log('Pro badges', proBadges.ok);

  // Petrol
  const proPetrol = await req('GET', '/api/analytics/petrol', null, proToken);
  log('Pro petrol', proPetrol.ok);

  // Category budgets
  const proCatBudgets = await req('GET', '/api/analytics/category-budgets', null, proToken);
  log('Pro category budgets', proCatBudgets.ok);

  // Family summary
  const proFamSum = await req('GET', '/api/analytics/family/summary', null, proToken);
  log('Pro family summary', proFamSum.ok);

  // Family categories
  const proFamCats = await req('GET', '/api/analytics/family/categories', null, proToken);
  log('Pro family categories', proFamCats.ok);

  // ==================== FREE ACCOUNT ====================
  console.log('\n--- FREE ACCOUNT (demo-free@housley.app / demo1234) ---');
  const freeToken = await login('demo-free@housley.app', 'demo1234', 'Free');
  if (!freeToken) { console.log('FATAL: Free login failed'); return; }

  const freeProfiles = await req('GET', '/api/auth/profiles', null, freeToken);
  log('Free profiles', freeProfiles.ok, 'count=' + (freeProfiles.data.users?.length || 0));

  const freeProvider = freeProfiles.data.users?.find(u => u.role === 'provider');
  const freeUser = await ensurePin(freeToken, freeProvider?._id, '1234', 'Free');

  const freeFam = await req('GET', '/api/family', null, freeToken);
  log('Free family settings', freeFam.ok, 'name=' + freeFam.data?.family?.name);

  const freeSt = await req('GET', '/api/pro/status', null, freeToken);
  log('Free pro status', freeSt.ok, `active=${freeSt.data?.active} tier=${freeSt.data?.tier}`);

  const freeCats = await req('GET', '/api/categories', null, freeToken);
  log('Free categories', freeCats.ok);

  const freeBal = await req('GET', '/api/funding/balances/groceries', null, freeToken);
  log('Free grocery balance', freeBal.ok);

  const freePeriod = await req('GET', '/api/periods/status', null, freeToken);
  log('Free period status', freePeriod.ok);

  const freeAct = await req('GET', '/api/activity?limit=5', null, freeToken);
  log('Free activity', freeAct.ok);

  // ==================== PRO GATING (Free account — expect 402) ====================
  console.log('\n--- PRO FEATURE GATING (Free account, expect 402) ---');

  const gateTests = [
    ['POST', '/api/ai/insights', {}, 'Free AI insights'],
    ['POST', '/api/ai/ask', { question: 'test' }, 'Free AI ask'],
    ['POST', '/api/ai/forecast', {}, 'Free AI forecast'],
    ['POST', '/api/ai/restock', {}, 'Free AI restock'],
    ['GET', '/api/export/period', null, 'Free PDF export'],
    ['POST', '/api/import/excel', { data: [] }, 'Free Excel import'],
  ];
  for (const [method, path, body, name] of gateTests) {
    const r = await req(method, path, body, freeToken);
    log(`${name} (expect 402)`, r.status === 402, `status=${r.status} code=${r.data?.code || ''}`);
  }

  // ==================== CRUD (Free account) ====================
  console.log('\n--- CRUD OPERATIONS (Free account) ---');

  // Fund groceries
  const addFund = await req('POST', '/api/funding/groceries', { amount: 50000, paymentMethod: 'cash', note: 'Test fund' }, freeToken);
  log('Free fund groceries', addFund.ok, addFund.ok ? 'ok' : `status=${addFund.status} ${addFund.data.error || ''}`);

  // Add expense
  const addExp = await req('POST', '/api/expenses/groceries', { description: 'Test Rice', amount: 1250, shop: 'TestMart', date: new Date().toISOString() }, freeToken);
  log('Free add expense', addExp.ok, addExp.ok ? `id=${addExp.data?.expense?._id}` : `status=${addExp.status} ${addExp.data.error || ''}`);

  const expId = addExp.data?.expense?._id;
  if (expId) {
    const listExp = await req('GET', '/api/transactions/expenses', null, freeToken);
    log('Free list expenses', listExp.ok, 'count=' + (listExp.data?.expenses?.length || 0));
    const delExp = await req('DELETE', '/api/transactions/expenses/' + expId, null, freeToken);
    log('Free delete expense', delExp.ok);
  }

  // Balance check
  const checkBal = await req('GET', '/api/funding/balances/groceries', null, freeToken);
  log('Free balance updated', checkBal.ok, 'funded=' + checkBal.data?.funded);

  // Add goal
  const addGoal = await req('POST', '/api/goals', { name: 'Test Goal', targetAmount: 100000 }, freeToken);
  log('Free add goal', addGoal.ok);

  // Add chore
  const addChore = await req('POST', '/api/chores', { title: 'Test Chore', emoji: '🧹', reward: 200, assignedTo: freeProvider?._id }, freeToken);
  log('Free add chore', addChore.ok, addChore.ok ? 'ok' : `status=${addChore.status} ${addChore.data.error || ''}`);

  // Add bill
  const addBill = await req('POST', '/api/bills', { name: 'Test Bill', expectedAmount: 5000, dueDayOfMonth: 15 }, freeToken);
  log('Free add bill', addBill.ok, addBill.ok ? 'ok' : `status=${addBill.status} ${addBill.data.error || ''}`);

  // Add shoutout
  const addShout = await req('POST', '/api/social/shoutouts', { text: 'Great job! 🎉' }, freeToken);
  log('Free add shoutout', addShout.ok, addShout.ok ? 'ok' : `status=${addShout.status} ${addShout.data.error || ''}`);

  // Add note
  const addNote = await req('POST', '/api/social/notes', { text: 'Test note' }, freeToken);
  log('Free add note', addNote.ok);

  // Add checklist
  const addCheck = await req('POST', '/api/checklist', { name: 'Test item', quantity: 1 }, freeToken);
  log('Free add checklist', addCheck.ok, addCheck.ok ? 'ok' : `status=${addCheck.status} ${addCheck.data.error || ''}`);

  // Add catalog
  const addCat = await req('POST', '/api/catalog', { name: 'Test Product', category: 'Groceries', stockStatus: 'good' }, freeToken);
  log('Free add catalog', addCat.ok);

  // Analytics (free)
  const freeWeek = await req('GET', '/api/analytics/weekly-recap', null, freeToken);
  log('Free weekly recap', freeWeek.ok);
  const freeByStore = await req('GET', '/api/analytics/groceries/by-store', null, freeToken);
  log('Free by store', freeByStore.ok);

  // Trend (might be gated)
  const freeTrend = await req('GET', '/api/analytics/trend?bucket=monthly', null, freeToken);
  log('Free trend', freeTrend.ok || freeTrend.status === 402, `status=${freeTrend.status}`);

  // Family summary
  const freeFamSum = await req('GET', '/api/analytics/family/summary', null, freeToken);
  log('Free family summary', freeFamSum.ok);

  // Invite code (free account)
  const freeInvite = await req('POST', '/api/family/invite', null, freeToken);
  log('Free invite code', freeInvite.ok, freeInvite.data?.code || '');

  // ==================== SECURITY TESTS ====================
  console.log('\n--- SECURITY ---');

  // No token
  const noAuth = await req('GET', '/api/auth/profiles');
  log('No auth (expect 401)', noAuth.status === 401, `status=${noAuth.status}`);

  // Bad token
  const badToken = await req('GET', '/api/auth/profiles', null, 'fake-token-xyz');
  log('Bad token (expect 401)', badToken.status === 401, `status=${badToken.status}`);

  // Cross-family: try free account accessing pro family data
  if (freeUser && proProvider) {
    const crossPin = await req('POST', '/api/auth/set-pin', { userId: proProvider._id, pin: '9999' }, freeToken);
    log('Cross-family PIN (expect 403)', crossPin.status === 403, `status=${crossPin.status}`);
  }

  // ==================== RESULTS ====================
  console.log('\n========================================');
  console.log('TEST RESULTS SUMMARY');
  console.log('========================================');
  let passed = 0, failed = 0, unexpected = 0;
  for (const r of results) {
    if (r.ok) passed++; else { failed++; if (!r.name.includes('expect')) unexpected++; }
    const icon = r.ok ? '✅' : (r.name.includes('expect') ? '⚠️ ' : '❌');
    console.log(`${icon} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
  }
  console.log('========================================');
  console.log(`PASSED: ${passed}  |  FAILED: ${failed}  |  UNEXPECTED FAILS: ${unexpected}`);
  console.log('========================================');

  return { passed, failed, unexpected, results };
}

run().catch(e => { console.error('Test crashed:', e); process.exit(1); });

/**
 * Housely — single-file Mongoose data model
 * Every schema for the whole family money app lives here.
 */

const mongoose = require('mongoose');

/** Helper: money stored in sen (1/100 of a ringgit) as an integer — avoids float drift. */
const money = {
  type: Number,
  required: true,
  min: 0,
  default: 0,
  get: (v) => v, // raw integer, frontend formats
};

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------
const familySchema = new mongoose.Schema(
  {
    name: { type: String, default: "My Family" },
    // v4 #18: Account type — personal, spouse, or family
    familyType: { type: String, enum: ['personal', 'spouse', 'family'], default: 'family' },
    periodType: { type: String, enum: ['monthly', 'weekly', 'annually'], default: 'monthly' },
    rolloverPolicy: { type: String, enum: ['carry_forward', 'reset'], default: 'carry_forward' },
    currency: { type: String, default: 'RM' },
    // v2.2 — family-wide AI switch (provider toggles it in Settings)
    aiEnabled: { type: Boolean, default: true },
    // Public version — 6-letter join code (no O/I/1/0), 24h expiry, 5 uses
    inviteCode: { type: String, default: null, trim: true, uppercase: true },
    inviteCodeExpiresAt: { type: Date, default: null },
    inviteUsesLeft: { type: Number, default: 0, min: 0 },
    // Public version — Pro subscription (one purchase = whole family)
    proTier: { type: String, enum: ['none', 'monthly', 'yearly', 'lifetime'], default: 'none' },
    proExpiresAt: { type: Date, default: null },
    proPurchasedAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null }, // 7-day free Pro trial from sign-up
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
const userSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Public version — every account has an email + hashed password.
    // Profiles added by the provider (spouse/kids) have no email of their own
    // (the field is left UNSET so the sparse unique index ignores them).
    email: { type: String, lowercase: true, trim: true, index: { unique: true, sparse: true } },
    passwordHash: { type: String, select: false },
    role: {
      type: String,
      enum: ['provider', 'grocery_spender', 'member', 'dependent'],
      required: true,
    },
    sortOrder: { type: Number, default: 99, min: 1 }, // family order in the picker
    pinHash: { type: String, default: null, select: false },
    biometricEnabled: { type: Boolean, default: false },
    avatarColor: { type: String, default: '#ff6f91' },
    avatarPhoto: { type: String, default: null }, // small base64 data URL — the member's own photo
    // Provider-set max a member may spend from Groceries in one trip (sen; 0 = unlimited)
    groceryTripLimit: { type: Number, default: 0, min: 0 },
    // Email verification — must be true before account is usable
    emailVerified: { type: Boolean, default: false },
    // PIN lockout fields
    failedAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    // Hashed long-lived refresh token used for biometric unlock
    refreshTokenHash: { type: String, default: null, select: false },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    avatarColor: this.avatarColor,
    avatarPhoto: this.avatarPhoto || null,
    hasPin: Boolean(this.pinHash),
    biometricEnabled: Boolean(this.biometricEnabled),
    emailVerified: Boolean(this.emailVerified),
    groceryTripLimit: this.groceryTripLimit || 0,
  };
};

// ---------------------------------------------------------------------------
// TrackingPeriod
// ---------------------------------------------------------------------------
const trackingPeriodSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
trackingPeriodSchema.index({ familyId: 1, status: 1 });

// ---------------------------------------------------------------------------
// GroceryBalance — one per family per period
// ---------------------------------------------------------------------------
const groceryBalanceSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    funded: money,
    spent: money,
    budgetAmount: money, // provider-set spending target (distinct from funded)
  },
  { timestamps: true }
);
groceryBalanceSchema.index({ familyId: 1, periodId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// PersonalBalance — one per user per period
// ---------------------------------------------------------------------------
const funderEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: money,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const personalBalanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    funded: money,
    spent: money,
    fundedBy: [funderEntrySchema], // who contributed and how much
  },
  { timestamps: true }
);
personalBalanceSchema.index({ userId: 1, periodId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// FundingTransaction — money in
// ---------------------------------------------------------------------------
const fundingTransactionSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    type: { type: String, enum: ['groceries', 'personal'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // target (groceries: whole family / personal: this user)
    fundedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // who did it
    amount: money,
    paymentMethod: {
      type: String,
      enum: ['online_banking', 'cash', 'credit_card', 'e_wallet'],
      required: true,
    },
    proofImage: { type: String, default: null }, // base64 data URL — required only for online_banking
    note: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// ExpenseTransaction — money out (with optional line items)
// ---------------------------------------------------------------------------
const lineItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, default: 1, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const expenseTransactionSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    type: { type: String, enum: ['groceries', 'personal'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // whose balance it comes from
    spentById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // who logged it
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    shopName: { type: String, trim: true, default: '' }, // denormalized so history works even if shop deleted
    category: { type: String, trim: true, maxlength: 60, default: 'Other' },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      enum: ['online_banking', 'cash', 'credit_card', 'e_wallet'],
      default: 'cash',
    },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    receiptImage: { type: String, default: null }, // optional base64 data URL — proof of the purchase
    lineItems: { type: [lineItemSchema], default: [] },
    // v3 — discount / tax (sen): the receipt's price adjustments. The stored
    // `amount` is the final paid total; these are kept as metadata so reports
    // can show "subtotal − discount + tax".
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    flags: {
      type: [String],
      default: [],
      enum: ['unusual', 'duplicate'],
    },
    imported: { type: Boolean, default: false },
  },
  { timestamps: true }
);
expenseTransactionSchema.index({ familyId: 1, periodId: 1 });
expenseTransactionSchema.index({ spentById: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------
const shopSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: {
      type: String,
      enum: ['groceries', 'meat', 'petrol', 'restaurant', 'pharmacy', 'utility', 'other'],
      default: 'other',
    },
    aliases: { type: [String], default: [] },
    usageCount: { type: Number, default: 0, min: 0 },
    learnedCategory: { type: String, trim: true, maxlength: 60, default: '' },
  },
  { timestamps: true }
);
shopSchema.index({ familyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// ActivityLog — append-only feed, powers the notification stream
// ---------------------------------------------------------------------------
const activityLogSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, default: '' },
    type: {
      type: String,
      enum: [
        'groceries_funded',
        'groceries_spent',
        'personal_funded',
        'personal_spent',
        'pin_set',
        'pin_reset',
        'period_closed',
        'period_opened',
        'goal_contributed',
        'goal_reached',
        'bill_paid',
        'checklist_bought',
        'catalog_updated',
        'expense_edited',
        'expense_deleted',
        'funding_deleted',
        'chore_approved',
        'shoutout',
        'roundup_saved',
        'period_under_budget',
      ],
      required: true,
    },
    subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // the person the event is ABOUT
    message: { type: String, required: true, trim: true, maxlength: 500 },
    amount: { type: Number, default: 0 },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);
activityLogSchema.index({ familyId: 1, createdAt: -1 });
activityLogSchema.index({ subjectUserId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// GroceryChecklistItem
// ---------------------------------------------------------------------------
const groceryChecklistItemSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: String, trim: true, maxlength: 40, default: '1' },
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    checked: { type: Boolean, default: false },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// GroceryCatalogItem — the family's memory of every known grocery item
// ---------------------------------------------------------------------------
const groceryCatalogItemSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, trim: true, maxlength: 60, default: 'Other' },
    stockStatus: { type: String, enum: ['in_stock', 'low', 'out'], default: 'in_stock' },
    barcode: { type: String, trim: true, maxlength: 32, default: '' }, // EAN-13 / UPC etc.
    timesBought: { type: Number, default: 0, min: 0 },
    lastBoughtAt: { type: Date, default: null },
  },
  { timestamps: true }
);
groceryCatalogItemSchema.index({ familyId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string', $ne: '' } } });
groceryCatalogItemSchema.index({ familyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------
const categorySchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
  },
  { timestamps: true }
);
categorySchema.index({ familyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// CategoryBudget — per period, per category
// ---------------------------------------------------------------------------
const categoryBudgetSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    budgetAmount: money,
  },
  { timestamps: true }
);
categoryBudgetSchema.index({ familyId: 1, periodId: 1, category: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// RecurringBill
// ---------------------------------------------------------------------------
const recurringBillSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    expectedAmount: money,
    dueDayOfMonth: { type: Number, required: true, min: 1, max: 31 },
    category: { type: String, trim: true, maxlength: 60, default: 'Utility Bills' },
    lastPaidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// SavingsGoal — standalone aspirational tracker
// ---------------------------------------------------------------------------
const goalContributionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 1 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const savingsGoalSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    targetAmount: { type: Number, required: true, min: 1 },
    currentAmount: { type: Number, default: 0, min: 0 },
    reached: { type: Boolean, default: false },
    reachedAt: { type: Date, default: null },
    emoji: { type: String, default: '🎯' },
    // #24 savings together — who contributed what (powers the leaderboard)
    contributions: { type: [goalContributionSchema], default: [] },
    // #25 birthday & event funds — an optional date the family is saving toward
    type: { type: String, enum: ['normal', 'event'], default: 'normal' },
    eventDate: { type: Date, default: null },
    // #6 round-up savings — spare change from expenses lands here automatically
    isRoundup: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// MealPlan — weekly dinner plans (feature #15)
// ---------------------------------------------------------------------------
const mealPlanSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    date: { type: Date, required: true }, // calendar day (YYYY-MM-DD at midnight)
    meal: { type: String, enum: ['dinner', 'lunch', 'breakfast'], default: 'dinner' },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    emoji: { type: String, default: '🍲' },
    ingredients: { type: [String], default: [] }, // free-text ingredient lines
    note: { type: String, trim: true, maxlength: 200, default: '' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);
mealPlanSchema.index({ familyId: 1, date: 1 });

// ---------------------------------------------------------------------------
// Chore — chore-to-allowance (feature #19)
// ---------------------------------------------------------------------------
const choreSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    emoji: { type: String, default: '🧹' },
    reward: { type: Number, required: true, min: 1 }, // sen paid on approval
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'done', 'approved'], default: 'pending' },
    completedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
choreSchema.index({ familyId: 1, status: 1, assignedTo: 1 });

// ---------------------------------------------------------------------------
// Shoutout — family thank-you feed (feature #21)
// ---------------------------------------------------------------------------
const shoutoutSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 300 },
    emoji: { type: String, default: '💛' },
    reacts: {
      type: [{ emoji: { type: String }, userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }],
      default: [],
    },
  },
  { timestamps: true }
);
shoutoutSchema.index({ familyId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// ProOrder — one ToyyibPay bill per checkout (powers the paywall)
// ---------------------------------------------------------------------------
const proOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true }, // our external reference (billExternalReferenceNo)
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    plan: { type: String, required: true },
    amountSen: { type: Number, required: true, min: 0 }, // 0 when 100% promo discount
    billCode: { type: String, default: null },
    status: { type: String, enum: ['pending', 'paid', 'failed', 'expired'], default: 'pending' },
    toyyibRefno: { type: String, default: null },
    paidAt: { type: Date, default: null },
    raw: { type: Object, default: {} }, // last ToyyibPay callback payload (debugging)
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// PinNote — family noticeboard (feature #22)
// ---------------------------------------------------------------------------
const pinNoteSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 300 },
    color: { type: String, default: '#ffe3e9' },
  },
  { timestamps: true }
);
pinNoteSchema.index({ familyId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Investment — track ASB, Tabung Haji, unit trusts etc.
// ---------------------------------------------------------------------------
const investmentSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: ['asb', 'th', 'unit_trust', 'stock', 'crypto', 'fd', 'other'], default: 'other' },
    currentValue: { type: Number, required: true, min: 0 }, // sen
    totalInvested: { type: Number, required: true, min: 0 }, // sen
    returns: { type: Number, default: 0 }, // sen (can be negative)
    note: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Debt — money lent/borrowed between family or outsiders
// ---------------------------------------------------------------------------
const debtSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    direction: { type: String, enum: ['lent', 'borrowed'], required: true },
    personName: { type: String, required: true, trim: true, maxlength: 80 },
    amount: { type: Number, required: true, min: 1 }, // sen
    repaidAmount: { type: Number, default: 0, min: 0 }, // sen
    note: { type: String, trim: true, maxlength: 200, default: '' },
    dueDate: { type: Date, default: null },
    settled: { type: Boolean, default: false },
    settledAt: { type: Date, default: null },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Subscription — track recurring payments (Netflix, etc.)
// ---------------------------------------------------------------------------
const subscriptionSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { type: Number, required: true, min: 1 }, // sen per billing cycle
    cycle: { type: String, enum: ['monthly', 'yearly', 'weekly'], default: 'monthly' },
    category: { type: String, trim: true, maxlength: 40, default: 'Entertainment' },
    nextBillingDate: { type: Date, default: null },
    active: { type: Boolean, default: true },
    note: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// CalendarEvent — family financial calendar
// ---------------------------------------------------------------------------
const calendarEventSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    date: { type: Date, required: true },
    type: { type: String, enum: ['bill', 'goal', 'income', 'reminder', 'other'], default: 'reminder' },
    amount: { type: Number, default: 0 }, // sen — optional
    recurring: { type: Boolean, default: false },
    note: { type: String, trim: true, maxlength: 200, default: '' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);
calendarEventSchema.index({ familyId: 1, date: 1 });

// ---------------------------------------------------------------------------
// ChatMessage — family in-app messaging
// ---------------------------------------------------------------------------
const chatMessageSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', default: null },
    reactions: {
      type: [{ emoji: String, userId: mongoose.Schema.Types.ObjectId }],
      default: [],
    },
  },
  { timestamps: true }
);
chatMessageSchema.index({ familyId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// SpendingChallenge — gamified savings challenges
// ---------------------------------------------------------------------------
const spendingChallengeSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    emoji: { type: String, default: '🏆' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    targetSpend: { type: Number, default: 0 }, // sen — 0 means no-spend
    category: { type: String, trim: true, maxlength: 60, default: '' }, // empty = all
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    status: { type: String, enum: ['active', 'completed', 'failed'], default: 'active' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// EducationLesson — teach kids about money
// ---------------------------------------------------------------------------
const educationLessonSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    content: { type: String, required: true, maxlength: 2000 },
    emoji: { type: String, default: '📚' },
    category: { type: String, enum: ['saving', 'budgeting', 'investing', 'needs_vs_wants', 'earning', 'other'], default: 'other' },
    completedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// BackupLog — data export history
// ---------------------------------------------------------------------------
const backupLogSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['full', 'expenses', 'goals'], default: 'full' },
    format: { type: String, enum: ['json', 'csv'], default: 'json' },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// NotificationPreference — per-user notification settings
// ---------------------------------------------------------------------------
const notificationPrefSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true, unique: true },
    billReminders: { type: Boolean, default: true },
    budgetAlerts: { type: Boolean, default: true },
    streakNotifications: { type: Boolean, default: true },
    challengeUpdates: { type: Boolean, default: true },
    chatMessages: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Register & export
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PromoCode — dynamic promo codes managed by admin
// ---------------------------------------------------------------------------
const promoCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    // Discount type: percent = % off, fixed = RM amount off
    discountType: { type: String, enum: ['percent', 'fixed'], required: true, default: 'percent' },
    // For percent: 0-100 (% off). For fixed: amount in sen (e.g. 300 = RM 3.00)
    discountValue: { type: Number, required: true, min: 0 },
    // Expiry: null = forever, Date = expires at
    expiresAt: { type: Date, default: null },
    // Target: empty array = everyone. Non-empty = only these emails can use it
    targetEmails: { type: [String], default: [] },
    // Usage limit: 0 = unlimited, N = max N families can use it
    maxUses: { type: Number, default: 0, min: 0 },
    currentUses: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
promoCodeSchema.index({ code: 1 });

// ---------------------------------------------------------------------------
// PromoCodeUsage — tracks which family used which promo code (one use per family)
// ---------------------------------------------------------------------------
const promoCodeUsageSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    orderId: { type: String, default: null },
    usedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
promoCodeUsageSchema.index({ familyId: 1, code: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// SecurityQuestion — user-selected questions + hashed answers for password reset
// ---------------------------------------------------------------------------
const securityQuestionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true, unique: true },
    questions: [
      {
        question: { type: String, required: true }, // the question text
        answerHash: { type: String, required: true }, // bcrypt hash of the answer (lowercase, trimmed)
      },
    ],
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// PasswordReset — 6-digit code (unused now, kept for potential future use)
// ---------------------------------------------------------------------------
const passwordResetSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    code: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { timestamps: true }
);
passwordResetSchema.index({ email: 1, used: 1 });

// ---------------------------------------------------------------------------
// EmailVerification — 6-digit code for email verification on register/join
// ---------------------------------------------------------------------------
const emailVerificationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    code: { type: String, required: true },
    purpose: { type: String, enum: ['register', 'join'], required: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { timestamps: true }
);
emailVerificationSchema.index({ email: 1, purpose: 1, used: 1 });

// ---------------------------------------------------------------------------
// AdminUser — separate admin accounts for the HQ dashboard
// ---------------------------------------------------------------------------
const adminUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ['superadmin', 'admin', 'viewer'], default: 'admin' },
    lastLogin: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// Announcement — admin broadcast to all users (e.g. "Update available")
// ---------------------------------------------------------------------------
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    type: { type: String, enum: ['update', 'info', 'warning', 'promo'], default: 'info' },
    linkUrl: { type: String, default: null }, // optional URL button (e.g. download page)
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// AppRelease — APK version management for update system
// ---------------------------------------------------------------------------
const appReleaseSchema = new mongoose.Schema(
  {
    version: { type: String, required: true, trim: true }, // e.g. "1.2.0"
    versionCode: { type: Number, required: true, min: 1 }, // numeric for comparison
    apkUrl: { type: String, default: null }, // R2 public URL after upload
    apkKey: { type: String, default: null }, // R2 object key
    apkSize: { type: Number, default: 0 }, // file size in bytes
    releaseNotes: { type: [String], default: [] },
    isMandatory: { type: Boolean, default: false },
    isLatest: { type: Boolean, default: false, index: true },
    publishedBy: { type: String, default: 'admin' }, // admin email
  },
  { timestamps: true }
);

module.exports = {
  AdminUser: mongoose.model('AdminUser', adminUserSchema),
  Family: mongoose.model('Family', familySchema),
  User: mongoose.model('User', userSchema),
  TrackingPeriod: mongoose.model('TrackingPeriod', trackingPeriodSchema),
  GroceryBalance: mongoose.model('GroceryBalance', groceryBalanceSchema),
  PersonalBalance: mongoose.model('PersonalBalance', personalBalanceSchema),
  FundingTransaction: mongoose.model('FundingTransaction', fundingTransactionSchema),
  ExpenseTransaction: mongoose.model('ExpenseTransaction', expenseTransactionSchema),
  Shop: mongoose.model('Shop', shopSchema),
  ActivityLog: mongoose.model('ActivityLog', activityLogSchema),
  GroceryChecklistItem: mongoose.model('GroceryChecklistItem', groceryChecklistItemSchema),
  GroceryCatalogItem: mongoose.model('GroceryCatalogItem', groceryCatalogItemSchema),
  Category: mongoose.model('Category', categorySchema),
  CategoryBudget: mongoose.model('CategoryBudget', categoryBudgetSchema),
  RecurringBill: mongoose.model('RecurringBill', recurringBillSchema),
  SavingsGoal: mongoose.model('SavingsGoal', savingsGoalSchema),
  MealPlan: mongoose.model('MealPlan', mealPlanSchema),
  Chore: mongoose.model('Chore', choreSchema),
  Shoutout: mongoose.model('Shoutout', shoutoutSchema),
  PinNote: mongoose.model('PinNote', pinNoteSchema),
  ProOrder: mongoose.model('ProOrder', proOrderSchema),
  Investment: mongoose.model('Investment', investmentSchema),
  Debt: mongoose.model('Debt', debtSchema),
  Subscription: mongoose.model('Subscription', subscriptionSchema),
  CalendarEvent: mongoose.model('CalendarEvent', calendarEventSchema),
  ChatMessage: mongoose.model('ChatMessage', chatMessageSchema),
  SpendingChallenge: mongoose.model('SpendingChallenge', spendingChallengeSchema),
  EducationLesson: mongoose.model('EducationLesson', educationLessonSchema),
  BackupLog: mongoose.model('BackupLog', backupLogSchema),
  NotificationPref: mongoose.model('NotificationPref', notificationPrefSchema),
  PromoCode: mongoose.model('PromoCode', promoCodeSchema),
  PromoCodeUsage: mongoose.model('PromoCodeUsage', promoCodeUsageSchema),
  PasswordReset: mongoose.model('PasswordReset', passwordResetSchema),
  SecurityQuestion: mongoose.model('SecurityQuestion', securityQuestionSchema),
  EmailVerification: mongoose.model('EmailVerification', emailVerificationSchema),
  Announcement: mongoose.model('Announcement', announcementSchema),
  AppRelease: mongoose.model('AppRelease', appReleaseSchema),
};

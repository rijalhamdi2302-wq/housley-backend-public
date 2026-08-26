require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const familySchema = new mongoose.Schema({
    name: String, familyType: { type: String, default: 'family' },
    inviteCode: String, createdBy: mongoose.Schema.Types.ObjectId,
  }, { timestamps: true });
  const Family = mongoose.model('Family', familySchema);

  const userSchema = new mongoose.Schema({
    email: String, password: String, name: String,
    familyId: mongoose.Schema.Types.ObjectId,
    role: { type: String, default: 'provider' },
    emailVerified: { type: Boolean, default: false },
    pin: String,
  }, { timestamps: true });
  userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    const bcrypt = require('bcryptjs');
    this.password = await bcrypt.hash(this.password, 10);
    next();
  });
  const User = mongoose.model('User', userSchema);

  // Check if accounts exist
  const existingPersonal = await User.findOne({ email: 'personal@housley.app' });
  if (existingPersonal) {
    console.log('Personal account already exists, skipping');
  } else {
    const pFam = await Family.create({ name: 'Rijal Personal', familyType: 'personal', inviteCode: 'PRS001' });
    const pUser = await User.create({
      email: 'personal@housley.app', password: 'demo1234', name: 'Rijal',
      familyId: pFam._id, role: 'provider', emailVerified: true, pin: '2302'
    });
    pFam.createdBy = pUser._id;
    await pFam.save();
    console.log('Personal account created: personal@housley.app / demo1234 / PIN: 2302');
  }

  const existingSpouse = await User.findOne({ email: 'spouse@housley.app' });
  if (existingSpouse) {
    console.log('Spouse account already exists, skipping');
  } else {
    const sFam = await Family.create({ name: 'Rijal Spouse', familyType: 'spouse', inviteCode: 'SPO001' });
    const sUser = await User.create({
      email: 'spouse@housley.app', password: 'demo1234', name: 'Spouse',
      familyId: sFam._id, role: 'spouse', emailVerified: true, pin: '2302'
    });
    sFam.createdBy = sUser._id;
    await sFam.save();
    console.log('Spouse account created: spouse@housley.app / demo1234 / PIN: 2302');
  }

  await mongoose.disconnect();
  console.log('Done!');
})().catch(e => { console.error(e); process.exit(1); });

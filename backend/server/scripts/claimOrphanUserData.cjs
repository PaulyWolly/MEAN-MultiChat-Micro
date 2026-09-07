/**
 * Give unowned documents an explicit owner.
 *
 * Data created before per-user scoping carries placeholder owners
 * ('default-user', 'migrated-user', null, ...). Once the read paths filter by
 * the caller's dataKey those documents would become invisible, so they are
 * assigned to the account that has always owned them.
 *
 * Only placeholder owners are touched. Documents already belonging to a real
 * account are never reassigned.
 *
 * Usage:
 *   node scripts/claimOrphanUserData.cjs            # dry run, reports only
 *   node scripts/claimOrphanUserData.cjs --apply    # perform the update
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const TARGET_EMAIL = 'pwelby@gmail.com';

// Placeholder owners from the single-user era. A real dataKey is never listed.
const ORPHAN_OWNERS = [
  'default-user',
  'migrated-user',
  'test-user',
  'default',
  'global-persistent-storage-001-v1',
];

const COLLECTIONS = [
  'youtube_searches',
  'youtubehistories',
  'clickedvideos',
  'watchlaters',
  'playlists',
  'collections',
];

const APPLY = process.argv.includes('--apply');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const owner = await db.collection('users').findOne({ email: TARGET_EMAIL });
  if (!owner?.dataKey) throw new Error(`No dataKey on ${TARGET_EMAIL}`);
  const dataKey = owner.dataKey;

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — target owner: ${TARGET_EMAIL} (${dataKey})\n`);

  // Never touch documents owned by another real account.
  const otherKeys = (
    await db
      .collection('users')
      .find({ dataKey: { $nin: [null, '', dataKey] } })
      .project({ dataKey: 1 })
      .toArray()
  ).map((u) => u.dataKey);
  if (otherKeys.length) console.log(`Protected owners: ${otherKeys.join(', ')}\n`);

  const filter = {
    $and: [
      { $or: [{ userId: { $in: ORPHAN_OWNERS } }, { userId: null }, { userId: { $exists: false } }] },
      { userId: { $nin: otherKeys } },
    ],
  };

  let total = 0;
  for (const name of COLLECTIONS) {
    if (!(await db.listCollections({ name }).hasNext())) continue;
    const n = await db.collection(name).countDocuments(filter);
    if (!n) {
      console.log(`  ${name}: nothing to claim`);
      continue;
    }
    if (APPLY) {
      const r = await db.collection(name).updateMany(filter, { $set: { userId: dataKey } });
      console.log(`  ${name}: claimed ${r.modifiedCount}`);
    } else {
      console.log(`  ${name}: would claim ${n}`);
    }
    total += n;
  }

  console.log(`\n${APPLY ? 'Claimed' : 'Would claim'} ${total} documents.`);
  if (!APPLY) console.log('Re-run with --apply to perform the update.');

  await mongoose.disconnect();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

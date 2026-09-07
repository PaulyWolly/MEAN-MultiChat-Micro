/**
 * Read-only audit of how existing documents are scoped.
 *
 * Reports the distinct userId values per collection so a scoping change can be
 * made without orphaning data that predates it. Performs no writes.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const COLLECTIONS = [
  'youtube_searches',
  'youtubesearches',
  'youtubehistories',
  'clickedvideos',
  'watchlaters',
  'playlists',
  'collections',
  'jokes',
  'personalinfos',
];

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Connected to database: ${db.databaseName}\n`);

  const users = await db
    .collection('users')
    .find({}, { projection: { email: 1, role: 1, dataKey: 1 } })
    .toArray();
  console.log(`ACCOUNTS (${users.length}):`);
  for (const u of users) {
    console.log(`  ${u.email}  role=${u.role || '-'}  dataKey=${u.dataKey || '(none)'}`);
  }

  const existing = (await db.listCollections().toArray()).map((c) => c.name);

  console.log('\nDOCUMENT SCOPES:');
  for (const name of COLLECTIONS) {
    if (!existing.includes(name)) {
      console.log(`\n  ${name}: (collection does not exist)`);
      continue;
    }
    const total = await db.collection(name).countDocuments();
    const groups = await db
      .collection(name)
      .aggregate([{ $group: { _id: '$userId', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
      .toArray();
    console.log(`\n  ${name}: ${total} docs`);
    for (const g of groups) {
      console.log(`      userId=${g._id === undefined ? '(field absent)' : JSON.stringify(g._id)}  ->  ${g.n}`);
    }
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

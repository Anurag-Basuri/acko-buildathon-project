// Ensure env.js has the variables it needs when tests import the app.
// The app under test never connects to a database in these tests;
// the value only needs to be present and well-formed.
process.env.DATABASE_URL ??=
  'postgresql://contractguard:contractguard@localhost:5432/contractguard_test';

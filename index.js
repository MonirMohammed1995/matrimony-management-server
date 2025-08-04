require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

// === Middlewares ===
app.use(cors());
app.use(express.json());

// === MongoDB Setup ===
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@phlearner.tk4afnk.mongodb.net/?retryWrites=true&w=majority&appName=PHLearner`;
const client = new MongoClient(uri, {
  serverApi: ServerApiVersion.v1,
});

// === JWT Middleware ===
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: 'Unauthorized Access' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ message: 'Forbidden Access' });
    req.user = decoded;
    next();
  });
};

async function run() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('matrimonyDB');
    const usersCollection = db.collection('users');
    const biodataCollection = db.collection('biodatas');

    // === JWT Token Issue ===
    app.post('/jwt', (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.send({ token });
    });

    // === User Registration ===
    app.post('/users', async (req, res) => {
      try {
        const user = req.body;
        const existing = await usersCollection.findOne({ email: user.email });
        if (existing) return res.send({ message: 'User already exists' });

        const newUser = {
          ...user,
          role: user.role || 'user',
          isActive: user.isActive !== undefined ? user.isActive : true,
        };

        const result = await usersCollection.insertOne(newUser);
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: 'Failed to register user' });
      }
    });

    // === Get All Users ===
    app.get('/users', verifyToken, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ error: 'Failed to fetch users' });
      }
    });

    // === Check Admin Role ===
    app.get('/users/admin/:email', verifyToken, async (req, res) => {
      try {
        const user = await usersCollection.findOne({ email: req.params.email });
        res.send({ isAdmin: user?.role === 'admin' });
      } catch (err) {
        res.status(500).send({ error: 'Failed to check admin status' });
      }
    });

    // === Get Role of a User ===
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ role: user?.role || null });
    });

    // === Update User Role ===
    app.patch('/users/role/:id', verifyToken, async (req, res) => {
      try {
        const { role } = req.body;
        if (!['admin', 'user'].includes(role)) {
          return res.status(400).send({ error: 'Invalid role' });
        }

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: 'Failed to update role' });
      }
    });

    // === Delete User ===
    app.delete('/users/:id', verifyToken, async (req, res) => {
      try {
        const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: 'Failed to delete user' });
      }
    });

    // === Add or Update Biodata ===
    app.put('/biodatas/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const data = req.body;

        const result = await biodataCollection.updateOne(
          { email },
          { $set: { ...data, updatedAt: new Date() } },
          { upsert: true }
        );

        const updated = await biodataCollection.findOne({ email });
        res.send({
          success: true,
          message: result.upsertedCount ? 'Biodata created' : 'Biodata updated',
          data: updated,
        });
      } catch (err) {
        res.status(500).send({ error: 'Failed to save biodata' });
      }
    });

    // === Get Biodata by Email ===
    app.get('/biodatas/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const biodata = await biodataCollection.findOne({ email });
        res.send(biodata || {});
      } catch (err) {
        res.status(500).send({ error: 'Failed to get biodata' });
      }
    });

    // === Mark Biodata as Premium Request ===
    app.patch('/biodatas/request-premium/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const result = await biodataCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { premiumRequest: true } }
        );
        res.send({ success: result.modifiedCount > 0 });
      } catch (err) {
        res.status(500).send({ error: 'Failed to request premium' });
      }
    });

    // === Admin: Approve Premium ===
    app.patch('/biodatas/approve-premium/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await biodataCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isPremium: true, premiumRequest: false } }
        );
        res.send({ success: result.modifiedCount > 0 });
      } catch (err) {
        res.status(500).send({ error: 'Failed to approve premium' });
      }
    });

    // === Filtering Biodata (Max 20) ===
    app.get('/biodatas', async (req, res) => {
      try {
        const {
          gender,
          permanentDivision,
          presentDivision,
          maritalStatus,
          minAge,
          maxAge,
        } = req.query;

        const query = {};

        if (gender) query.biodataType = gender;
        if (permanentDivision) query.permanentDivision = permanentDivision;
        if (presentDivision) query.presentDivision = presentDivision;
        if (maritalStatus) query.maritalStatus = maritalStatus;

        if (minAge && maxAge) {
          query.age = { $gte: parseInt(minAge), $lte: parseInt(maxAge) };
        } else if (minAge) {
          query.age = { $gte: parseInt(minAge) };
        } else if (maxAge) {
          query.age = { $lte: parseInt(maxAge) };
        }

        const result = await biodataCollection.find(query).limit(20).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: 'Failed to fetch biodata list' });
      }
    });

    // === Root Route ===
    app.get('/', (req, res) => {
      res.send('🧡 Matrimony Server is Running...');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
  }
}

run().catch(console.dir);

// === Start Express Server ===
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});

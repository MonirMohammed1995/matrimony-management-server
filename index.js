require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// === Middleware ===
app.use(cors());
app.use(express.json());

// === MongoDB Connection ===
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@phlearner.tk4afnk.mongodb.net/?retryWrites=true&w=majority&appName=PHLearner`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// === Collections ===
let usersCollection, biodatasCollection, favouritesCollection, contactRequestsCollection, successStoriesCollection;

// === Main Function ===
async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB!");

    const db = client.db('matrimonyDB');
    usersCollection = db.collection('users');
    biodatasCollection = db.collection('biodatas');
    favouritesCollection = db.collection('my-favourites');
    contactRequestsCollection = db.collection('contactRequests');
    successStoriesCollection = db.collection('successStories');

    // === JWT Token ===
    app.post('/jwt', (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.send({ token });
    });

    // === Middleware: Token Verification ===
    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).send({ error: 'unauthorized access' });

      const token = authHeader.split(' ')[1];
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).send({ error: 'forbidden access' });
        req.decoded = decoded;
        next();
      });
    };

    // === Users ===
    app.post('/users', async (req, res) => {
      try {
        const user = req.body;
        const existing = await usersCollection.findOne({ email: user.email });
        if (existing) return res.send({ message: 'User already exists' });
        const result = await usersCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: 'Failed to add user' });
      }
    });

    app.get('/users', verifyToken, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.get('/users/:email', verifyToken, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.params.email });
      res.send(result);
    });

    app.patch('/users/role/:id', verifyToken, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );
      res.send(result);
    });

    // === Biodata ===
    app.post('/biodatas', verifyToken, async (req, res) => {
      const biodata = req.body;
      const last = await biodatasCollection.find().sort({ biodataId: -1 }).limit(1).toArray();
      const newId = last.length ? last[0].biodataId + 1 : 1;
      biodata.biodataId = newId;
      const result = await biodatasCollection.insertOne(biodata);
      res.send(result);
    });

    app.get('/biodatas', async (req, res) => {
      const result = await biodatasCollection.find().toArray();
      res.send(result);
    });

    app.get('/biodatas/:id', verifyToken, async (req, res) => {
      const id = parseInt(req.params.id);
      const result = await biodatasCollection.findOne({ biodataId: id });
      res.send(result);
    });

    // === Favourites ===
    app.post('/favourites', verifyToken, async (req, res) => {
      const data = req.body;
      const result = await favouritesCollection.insertOne(data);
      res.send(result);
    });

    app.get('/favourites/:email', verifyToken, async (req, res) => {
      const result = await favouritesCollection.find({ email: req.params.email }).toArray();
      res.send(result);
    });

    app.delete('/favourites/:id', verifyToken, async (req, res) => {
      const result = await favouritesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    // === Contact Request ===
    app.post('/contact-request', verifyToken, async (req, res) => {
      const data = req.body;
      data.status = 'pending';
      const result = await contactRequestsCollection.insertOne(data);
      res.send(result);
    });

    app.get('/contact-request/:email', verifyToken, async (req, res) => {
      const result = await contactRequestsCollection.find({ email: req.params.email }).toArray();
      res.send(result);
    });

    app.patch('/contact-request/approve/:id', verifyToken, async (req, res) => {
      const result = await contactRequestsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { status: 'approved' } }
      );
      res.send(result);
    });

    // === Stripe Payment ===
    app.post('/create-payment-intent', verifyToken, async (req, res) => {
      try {
        const { price } = req.body;
        const amount = parseInt(price * 100);
        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: 'usd',
          payment_method_types: ['card'],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: 'Stripe error', message: err.message });
      }
    });

    // === Success Stories ===
    app.post('/success-story', verifyToken, async (req, res) => {
      const story = req.body;
      const result = await successStoriesCollection.insertOne(story);
      res.send(result);
    });

    app.get('/success-stories', async (req, res) => {
      const result = await successStoriesCollection.find().sort({ date: -1 }).toArray();
      res.send(result);
    });

  } catch (err) {
    console.error('❌ Server Error:', err);
  }
}

run().catch(console.dir);

// === Base Route ===
app.get('/', (req, res) => {
  res.send('🧡 Matrimony server is running');
});

// === Listen ===
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});

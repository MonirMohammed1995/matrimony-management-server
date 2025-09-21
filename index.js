require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- MongoDB Setup ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@phlearner.tk4afnk.mongodb.net/?retryWrites=true&w=majority&appName=PHLearner`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

/* === Middleware: JWT verify === */
function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "Unauthorized access" });
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ message: "Forbidden access" });
    req.decoded = decoded; // contains email
    next();
  });
}

/* === Middleware: Admin check === */
async function verifyAdmin(req, res, next) {
  try {
    const email = req.decoded?.email;
    if (!email) return res.status(401).send({ message: "Unauthorized" });
    const user = await req.app.locals.collections.users.findOne({ email });
    if (!user || user.role !== "admin") return res.status(403).send({ message: "Admin access required" });
    next();
  } catch (err) {
    console.error("verifyAdmin error:", err);
    res.status(500).send({ error: "Server error" });
  }
}

/* === Helper: Auto increment biodataId === */
async function getNextBiodataId(countersCollection) {
  const result = await countersCollection.findOneAndUpdate(
    { _id: "biodataId" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return result.value.seq;
}

/* === Start DB connection and define routes === */
async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("MatrimonyDB");
    const usersCollection = db.collection("users");
    const biodataCollection = db.collection("biodatas");
    const contactRequestsCollection = db.collection("contactRequests");
    const premiumRequestsCollection = db.collection("premiumRequests");
    const paymentsCollection = db.collection("payments");
    const successStoriesCollection = db.collection("successStories");
    const favouritesCollection = db.collection("favourites");
    const countersCollection = db.collection("counters");

    app.locals.collections = {
      users: usersCollection,
      biodatas: biodataCollection,
      contactRequests: contactRequestsCollection,
      premiumRequests: premiumRequestsCollection,
      payments: paymentsCollection,
      successStories: successStoriesCollection,
      favourites: favouritesCollection,
    };

    /* ---------------------------
       AUTH / USER ROUTES
       --------------------------- */

    app.post("/jwt", (req, res) => {
      const user = req.body;
      if (!user?.email) return res.status(400).send({ error: "Email required" });
      const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET, { expiresIn: "5h" });
      res.send({ token });
    });

    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        if (!user?.email) return res.status(400).send({ error: "Email required" });
        const filter = { email: user.email };
        const update = { $set: { ...user, role: user.role || "user", updatedAt: new Date() } };
        const opts = { upsert: true };
        const result = await usersCollection.updateOne(filter, update, opts);
        res.status(200).send({ result });
      } catch (err) {
        res.status(500).send({ error: "Failed to add/upsert user" });
      }
    });

    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const q = req.query.q || "";
        const filter = q ? { name: { $regex: q, $options: "i" } } : {};
        const users = await usersCollection.find(filter).toArray();
        res.send(users);
      } catch {
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    app.get("/users/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        const requester = req.decoded?.email;
        if (requester !== email) {
          const reqUser = await usersCollection.findOne({ email: requester });
          if (!reqUser || reqUser.role !== "admin") {
            return res.status(403).send({ message: "Forbidden" });
          }
        }
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });
        res.send(user);
      } catch {
        res.status(500).send({ error: "Failed to fetch user" });
      }
    });

    app.patch("/users/:id/make-admin", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid user id" });
        const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: "admin" } });
        res.send(result);
      } catch {
        res.status(500).send({ error: "Failed to make admin" });
      }
    });

    app.patch("/users/:id/make-premium", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid user id" });
        const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { isPremium: true } });
        res.send(result);
      } catch {
        res.status(500).send({ error: "Failed to make premium" });
      }
    });

    /* ---------------------------
       BIODATA ROUTES
       --------------------------- */

    app.post("/biodatas", verifyJWT, async (req, res) => {
      try {
        const biodata = req.body;
        if (!biodata.name) return res.status(400).send({ error: "Name is required" });

        biodata.biodataId = await getNextBiodataId(countersCollection);
        biodata.ownerEmail = req.decoded.email;
        biodata.createdAt = new Date();

        const result = await biodataCollection.insertOne(biodata);
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to create biodata" });
      }
    });

    app.put("/biodatas/:id", verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid id" });
        const updateData = req.body;

        const biodata = await biodataCollection.findOne({ _id: new ObjectId(id) });
        if (!biodata) return res.status(404).send({ error: "Biodata not found" });

        if (biodata.ownerEmail !== req.decoded.email) {
          const reqUser = await usersCollection.findOne({ email: req.decoded.email });
          if (!reqUser || reqUser.role !== "admin") {
            return res.status(403).send({ message: "Forbidden" });
          }
        }

        const result = await biodataCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
        res.send(result);
      } catch {
        res.status(500).send({ error: "Failed to update biodata" });
      }
    });

    app.delete("/biodatas/:id", verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid id" });

        const biodata = await biodataCollection.findOne({ _id: new ObjectId(id) });
        if (!biodata) return res.status(404).send({ error: "Biodata not found" });

        if (biodata.ownerEmail !== req.decoded.email) {
          const reqUser = await usersCollection.findOne({ email: req.decoded.email });
          if (!reqUser || reqUser.role !== "admin") {
            return res.status(403).send({ message: "Forbidden" });
          }
        }

        const result = await biodataCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch {
        res.status(500).send({ error: "Failed to delete biodata" });
      }
    });

    app.get("/biodatas/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid biodata ID" });
        const item = await biodataCollection.findOne({ _id: new ObjectId(id) });
        if (!item) return res.status(404).send({ message: "Biodata not found" });
        res.send(item);
      } catch {
        res.status(500).send({ error: "Failed to fetch biodata" });
      }
    });

    app.get("/biodatas", async (req, res) => {
      try {
        const { gender, permanentDivision, presentDivision, minAge, maxAge, page = 1, limit = 0, sort = "asc", q } =
          req.query;

        const query = {};
        if (gender) query.biodataType = new RegExp(`^${gender}$`, "i");
        if (permanentDivision) query.permanentDivision = permanentDivision;
        if (presentDivision) query.presentDivision = presentDivision;
        if (minAge && maxAge) query.age = { $gte: parseInt(minAge), $lte: parseInt(maxAge) };
        if (q) {
          query.$or = [
            { name: { $regex: q, $options: "i" } },
            { occupation: { $regex: q, $options: "i" } },
            { permanentDivision: { $regex: q, $options: "i" } },
          ];
        }

        const sortOrder = sort === "desc" ? -1 : 1;
        const skipCount = (parseInt(page) - 1) * parseInt(limit || 0);

        let cursor = biodataCollection.find(query).sort({ age: sortOrder });
        if (parseInt(limit) > 0) cursor = cursor.skip(skipCount).limit(parseInt(limit));

        const biodatas = await cursor.toArray();
        const total = await biodataCollection.countDocuments(query);

        res.send({ total, page: parseInt(page), limit: parseInt(limit), biodatas });
      } catch {
        res.status(500).send({ error: "Failed to get biodatas" });
      }
    });

    /* ---------------------------
       PAYMENT & CONTACT REQUESTS
       --------------------------- */

    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      try {
        const { amount } = req.body;
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0) return res.status(400).send({ error: "Valid amount required" });

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amountNum * 100),
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch {
        res.status(500).send({ error: "Failed to create payment intent" });
      }
    });

    app.post("/payments", verifyJWT, async (req, res) => {
      try {
        const payment = req.body;
        if (!payment || !payment.biodataId) return res.status(400).send({ error: "Payment with biodataId required" });
        payment.createdAt = new Date();
        const result = await paymentsCollection.insertOne(payment);

        const contactReq = {
          biodataId: payment.biodataId,
          requesterEmail: payment.requesterEmail,
          status: "pending",
          paymentId: result.insertedId,
          createdAt: new Date(),
        };
        await contactRequestsCollection.insertOne(contactReq);

        res.status(201).send({ paymentResult: result, contactRequest: contactReq });
      } catch {
        res.status(500).send({ error: "Failed to save payment" });
      }
    });

    /* ---------------------------
       PREMIUM REQUESTS
       --------------------------- */
    app.post("/premium-requests", verifyJWT, async (req, res) => {
      try {
        const payload = req.body;
        if (!payload?.biodataId) return res.status(400).send({ error: "biodataId required" });

        payload.status = "pending";
        payload.createdAt = new Date();
        const result = await premiumRequestsCollection.insertOne(payload);
        res.status(201).send(result);
      } catch {
        res.status(500).send({ error: "Failed to create premium request" });
      }
    });

    /* ---------------------------
       FAVOURITES
       --------------------------- */
    app.post("/favourites", verifyJWT, async (req, res) => {
      try {
        const fav = req.body;
        if (!fav?.biodataId) return res.status(400).send({ error: "biodataId required" });
        fav.userEmail = req.decoded.email;
        fav.createdAt = new Date();
        const result = await favouritesCollection.insertOne(fav);
        res.status(201).send(result);
      } catch {
        res.status(500).send({ error: "Failed to add favourite" });
      }
    });

    app.get("/favourites/my", verifyJWT, async (req, res) => {
      try {
        const email = req.decoded.email;
        const favs = await favouritesCollection.find({ userEmail: email }).toArray();
        res.send(favs);
      } catch {
        res.status(500).send({ error: "Failed to fetch favourites" });
      }
    });

    /* ---------------------------
       SUCCESS STORIES
       --------------------------- */
    app.post("/success-stories", verifyJWT, async (req, res) => {
      try {
        const story = req.body;
        story.createdAt = new Date();
        const result = await successStoriesCollection.insertOne(story);
        res.status(201).send(result);
      } catch {
        res.status(500).send({ error: "Failed to add success story" });
      }
    });

    app.get("/success-stories", async (req, res) => {
      try {
        const stories = await successStoriesCollection.find().sort({ marriageDate: -1 }).toArray();
        res.send(stories);
      } catch {
        res.status(500).send({ error: "Failed to fetch success stories" });
      }
    });

    /* ---------------------------
       DASHBOARD / STATS
       --------------------------- */
    app.get("/admin/stats", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const total = await biodataCollection.countDocuments();
        const male = await biodataCollection.countDocuments({ biodataType: { $regex: /^male$/i } });
        const female = await biodataCollection.countDocuments({ biodataType: { $regex: /^female$/i } });
        const premiumCount = await biodataCollection.countDocuments({ isPremium: true });
        const revenueAgg = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
        const revenue = revenueAgg[0]?.total || 0;

        res.send({ total, male, female, premiumCount, revenue });
      } catch {
        res.status(500).send({ error: "Failed to fetch stats" });
      }
    });

    /* ---------------------------
       Root & Health check
       --------------------------- */
    app.get("/", (req, res) => {
      res.send("❤️ Matrimony Server is Running");
    });

    console.log("✅ All routes configured.");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Server startup error:", err);
  process.exit(1);
});

app.listen(port, () => {
  console.log(`🚀 Matrimony server running at http://localhost:${port}`);
});

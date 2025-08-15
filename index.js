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
const client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });

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

/* === Middleware: Admin check ===
   Expects verifyJWT run before this.
*/
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

    // expose collections via app.locals for middleware access
    app.locals.collections = {
      users: usersCollection,
      biodatas: biodataCollection,
      contactRequests: contactRequestsCollection,
      premiumRequests: premiumRequestsCollection,
      payments: paymentsCollection,
      successStories: successStoriesCollection,
    };

    /* ---------------------------
       AUTH / USER ROUTES
       --------------------------- */

    // Create JWT token (client sends { email })
    app.post("/jwt", (req, res) => {
      const user = req.body;
      if (!user?.email) return res.status(400).send({ error: "Email required" });
      const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET, { expiresIn: "5h" });
      res.send({ token });
    });

    // Add or upsert user on signup/login
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        if (!user?.email) return res.status(400).send({ error: "Email required" });
        // upsert so repeat sign-ins update profile without duplicates
        const filter = { email: user.email };
        const update = { $set: { ...user, role: user.role || "user", updatedAt: new Date() } };
        const opts = { upsert: true };
        const result = await usersCollection.updateOne(filter, update, opts);
        res.status(200).send({ result });
      } catch (err) {
        console.error("POST /users err:", err);
        res.status(500).send({ error: "Failed to add/upsert user" });
      }
    });

    // Get all users (admin only)
    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const q = req.query.q || "";
        const filter = q ? { name: { $regex: q, $options: "i" } } : {};
        const users = await usersCollection.find(filter).toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    // Get single user by email (private - user or admin)
    app.get("/users/:email", verifyJWT, async (req, res) => {
      try {
        const email = req.params.email;
        const requester = req.decoded?.email;
        if (requester !== email) {
          // allow admins to fetch others
          const reqUser = await usersCollection.findOne({ email: requester });
          if (!reqUser || reqUser.role !== "admin") {
            return res.status(403).send({ message: "Forbidden" });
          }
        }
        const user = await usersCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: "User not found" });
        res.send(user);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch user" });
      }
    });

    // Make user admin (admin only)
    app.patch("/users/:id/make-admin", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid user id" });
        const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: "admin" } });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to make admin" });
      }
    });

    // Make user premium (admin only)
    app.patch("/users/:id/make-premium", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid user id" });
        const result = await usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { isPremium: true } });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to make premium" });
      }
    });

    /* ---------------------------
       BIODATA ROUTES
       --------------------------- */

    // Create biodata with auto-incremented biodataId (private)
    app.post("/biodatas", verifyJWT, async (req, res) => {
      try {
        const biodata = req.body;
        // minimal validation
        if (!biodata.name) return res.status(400).send({ error: "Name is required" });

        // compute next biodataId
        const last = await biodataCollection.find().sort({ biodataId: -1 }).limit(1).toArray();
        biodata.biodataId = last.length ? last[0].biodataId + 1 : 1;
        biodata.createdAt = new Date();
        const result = await biodataCollection.insertOne(biodata);
        res.status(201).send(result);
      } catch (err) {
        console.error("POST /biodatas err:", err);
        res.status(500).send({ error: "Failed to create biodata" });
      }
    });

    // Update biodata (owner or admin) - private
    app.put("/biodatas/:id", verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid id" });
        const updateData = req.body;

        // optionally: verify owner by email stored in biodata.contactEmail === req.decoded.email
        const result = await biodataCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to update biodata" });
      }
    });

    // Delete biodata (owner or admin) - private
    app.delete("/biodatas/:id", verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid id" });
        const result = await biodataCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to delete biodata" });
      }
    });

    // Get biodata by mongo id (public) - details page (private on frontend)
    app.get("/biodatas/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid biodata ID" });
        const item = await biodataCollection.findOne({ _id: new ObjectId(id) });
        if (!item) return res.status(404).send({ message: "Biodata not found" });
        res.send(item);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch biodata" });
      }
    });

    // Get similar biodatas by biodataType (gender) excluding current id (public)
    app.get("/biodatas/similar", async (req, res) => {
      try {
        const { gender, exclude } = req.query;
        if (!gender) return res.status(400).send({ error: "Gender required" });
        const query = { biodataType: new RegExp(`^${gender}$`, "i") };
        if (exclude && ObjectId.isValid(exclude)) query._id = { $ne: new ObjectId(exclude) };
        const result = await biodataCollection.find(query).limit(3).toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to get similar biodatas" });
      }
    });

    // Get biodatas with filters, pagination, sorting (public)
    app.get("/biodatas", async (req, res) => {
      try {
        const {
          gender,
          permanentDivision,
          presentDivision,
          minAge,
          maxAge,
          page = 1,
          limit = 0,
          sort = "asc",
          q, // optional text search
        } = req.query;

        const query = {};

        if (gender) query.biodataType = new RegExp(`^${gender}$`, "i");
        if (permanentDivision) query.permanentDivision = permanentDivision;
        if (presentDivision) query.presentDivision = presentDivision;

        if (minAge && maxAge) {
          query.age = { $gte: parseInt(minAge), $lte: parseInt(maxAge) };
        }

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

        res.send({
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          biodatas,
        });
      } catch (err) {
        console.error("GET /biodatas err:", err);
        res.status(500).send({ error: "Failed to get biodatas" });
      }
    });

    /* ---------------------------
       CONTACT REQUESTS & STRIPE
       --------------------------- */

    // Create Stripe Payment Intent (private)
    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      try {
        const { amount } = req.body;
        if (!amount || isNaN(amount) || amount <= 0) {
          return res.status(400).send({ error: "Valid amount required" });
        }
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        console.error("Stripe err:", err);
        res.status(500).send({ error: "Failed to create payment intent" });
      }
    });

    // Save payment record after successful payment on client (private)
    app.post("/payments", verifyJWT, async (req, res) => {
      try {
        const payment = req.body;
        if (!payment || !payment.biodataId) return res.status(400).send({ error: "Payment with biodataId required" });
        payment.createdAt = new Date();
        const result = await paymentsCollection.insertOne(payment);

        // create contact request entry as pending
        const contactReq = {
          biodataId: payment.biodataId,
          requesterEmail: payment.requesterEmail,
          status: "pending",
          paymentId: result.insertedId,
          createdAt: new Date(),
        };
        await contactRequestsCollection.insertOne(contactReq);

        res.status(201).send({ paymentResult: result, contactRequest: contactReq });
      } catch (err) {
        console.error("POST /payments err:", err);
        res.status(500).send({ error: "Failed to save payment" });
      }
    });

    // Admin: Approve contact request (admin only)
    app.patch("/contact-requests/:id/approve", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid id" });
        const updated = await contactRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "approved", approvedAt: new Date() } }
        );
        res.send(updated);
      } catch (err) {
        res.status(500).send({ error: "Failed to approve contact request" });
      }
    });

    // Get user's contact requests (private)
    app.get("/my-contact-requests", verifyJWT, async (req, res) => {
      try {
        const email = req.decoded.email;
        const results = await contactRequestsCollection.find({ requesterEmail: email }).toArray();
        res.send(results);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch contact requests" });
      }
    });

    /* ---------------------------
       PREMIUM REQUESTS
       --------------------------- */

    // Request premium (user sends biodataId & userEmail) - private
    app.post("/premium-requests", verifyJWT, async (req, res) => {
      try {
        const payload = req.body;
        if (!payload?.biodataId) return res.status(400).send({ error: "biodataId required" });

        payload.status = "pending";
        payload.createdAt = new Date();
        const result = await premiumRequestsCollection.insertOne(payload);
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to create premium request" });
      }
    });

    // Admin: Approve premium (admin only)
    app.patch("/premium-requests/:id/approve", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).send({ error: "Invalid id" });

        const reqDoc = await premiumRequestsCollection.findOne({ _id: new ObjectId(id) });
        if (!reqDoc) return res.status(404).send({ message: "Request not found" });

        // mark premium request approved
        await premiumRequestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: "approved", approvedAt: new Date() } });

        // set the associated biodata to premium
        await biodataCollection.updateOne({ biodataId: parseInt(reqDoc.biodataId) }, { $set: { isPremium: true } });

        res.send({ message: "Premium approved" });
      } catch (err) {
        res.status(500).send({ error: "Failed to approve premium request" });
      }
    });

    // Get all pending premium requests (admin)
    app.get("/premium-requests", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const results = await premiumRequestsCollection.find().toArray();
        res.send(results);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch premium requests" });
      }
    });

    /* ---------------------------
       FAVOURITES (simple collection)
       --------------------------- */

    // Add to favourites (private)
    app.post("/favourites", verifyJWT, async (req, res) => {
      try {
        const fav = req.body;
        if (!fav?.biodataId) return res.status(400).send({ error: "biodataId required" });
        fav.userEmail = req.decoded.email;
        fav.createdAt = new Date();
        const result = await db.collection("favourites").insertOne(fav);
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to add favourite" });
      }
    });

    // Get my favourites (private)
    app.get("/favourites/my", verifyJWT, async (req, res) => {
      try {
        const email = req.decoded.email;
        const favs = await db.collection("favourites").find({ userEmail: email }).toArray();
        res.send(favs);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch favourites" });
      }
    });

    /* ---------------------------
       SUCCESS STORIES
       --------------------------- */

    // Add success story (private)
    app.post("/success-stories", verifyJWT, async (req, res) => {
      try {
        const story = req.body;
        story.createdAt = new Date();
        const result = await successStoriesCollection.insertOne(story);
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to add success story" });
      }
    });

    // Get success stories sorted by marriageDate desc (public)
    app.get("/success-stories", async (req, res) => {
      try {
        const stories = await successStoriesCollection.find().sort({ marriageDate: -1 }).toArray();
        res.send(stories);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch success stories" });
      }
    });

    /* ---------------------------
       DASHBOARD / STATS (admin)
       --------------------------- */

    // Dashboard stats: counts + total revenue (admin)
    app.get("/admin/stats", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const total = await biodataCollection.countDocuments();
        const male = await biodataCollection.countDocuments({ biodataType: { $regex: /^male$/i } });
        const female = await biodataCollection.countDocuments({ biodataType: { $regex: /^female$/i } });
        const premiumCount = await biodataCollection.countDocuments({ isPremium: true });
        const revenueAgg = await paymentsCollection.aggregate([
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).toArray();
        const revenue = revenueAgg[0]?.total || 0;

        res.send({ total, male, female, premiumCount, revenue });
      } catch (err) {
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

// Start server
app.listen(port, () => {
  console.log(`🚀 Matrimony server running at http://localhost:${port}`);
});

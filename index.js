const express = require("express");
require("dotenv").config();
const cors = require("cors");
const Stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin
const admin = require("firebase-admin");
const e = require("express");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------------------------
// MIDDLEWARE: VERIFY TOKEN
// ---------------------------
const verifyFBtoken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decode = await admin.auth().verifyIdToken(idToken);

    req.decode_email = decode.email;
    next();
  } catch (err) {
    return res.status(403).send({ message: "invalid or expired token" });
  }
};

app.use(express.json());
app.use(cors());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_NAME}:${process.env.DB_PASS}@cluster0.4xbagdk.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    console.log("Connected to MongoDB successfully!");

    const db = client.db("zap_shift");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const trackingCollection = db.collection("tracking");

    // Admin verify token
    const verifyAdmin = async (req, res, next) => {
      const email = req.decode_email;
      const filter = { email };
      const user = await usersCollection.findOne(filter);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    // =======================
    // Riders API
    // =======================
    app.get("/", (req, res) => {
      res.send("Rideshift Server is Running 🚀");
    });
    app.delete("/riders/:id", async (req, res) => {
      const filter = { _id: new ObjectId(req.params.id) };
      const result = await ridersCollection.deleteOne(filter);
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;

      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status,
          workStatus: "available",
        },
      };

      await ridersCollection.updateOne(query, update);

      if (status === "approved") {
        const email = req.body.email;
        const query = { email };
        const updateUser = { $set: { role: "rider" } };
        const userResult = await usersCollection.updateOne(query, updateUser);
        res.send(userResult);
      }
    });
// =========================================================
app.get("/test-stripe", (req, res) => {
  try {
    if (!Stripe) throw new Error("Stripe not defined");
    res.send({ success: true, message: "Stripe is defined ✅" });
  } catch (err) {
    res.status(500).send({ success: false, message: err.message });
  }
});
// =========================================================

    app.post("/riders", async (req, res) => {
      const riders = req.body;
      riders.status = "pending";
      riders.createdAt = new Date();
      const result = await ridersCollection.insertOne(riders);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const query = {};
      const { status, district, workStatus } = req.query;

      if (status) query.status = status;
      if (district) query.district = district;
      if (workStatus) query.workStatus = workStatus;

      const result = await ridersCollection.find(query).toArray();
      res.send(result);
    });

    // =======================
    // Users API
    // =======================
    app.get("/user", async (req, res) => {
      const { email } = req.query;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;

      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const exist = await usersCollection.findOne({ email });

      if (exist) {
        return res.send({ message: "already available this user" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch("/user/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const userInfo = req.body;

      const filter = { _id: new ObjectId(id) };
      const update = { $set: { role: userInfo.role } };

      const result = await usersCollection.updateOne(filter, update);
      res.send(result);
    });

    app.get("/users/:email/role", verifyFBtoken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send({ role: result?.role || "user" });
    });

    // ===========================
    // STRIPE CHECKOUT SESSION
    // ===========================
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
        console.log(req.body);

        const amount = parseInt(paymentInfo.cost) * 100;

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "USD",
                unit_amount: amount,
                product_data: {
                  name: paymentInfo.parcelName,
                },
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.senderEmail,
          metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName,
          },
          mode: "payment",
          success_url: `${process.env.SITE_DOMAIN}dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}dashboard/payment-cancelled`,
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(400).send({ error: error.message });
      }
    });

    // ===========================
    // PAYMENT SUCCESS (CLEAN)
    // ===========================
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ error: "Payment not completed" });
        }

        const parcelId = session.metadata.parcelId;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ error: "Parcel not found" });
        }

        let trackingId = parcel.trackingId;

        if (!trackingId) {
          trackingId = generateTrackingIdSecure();
          await parcelsCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            { $set: { trackingId } }
          );
        }

        const transactionId = session.payment_intent;
        const existingPayment = await paymentCollection.findOne({
          transactionId,
        });

        if (existingPayment) {
          return res.send({
            message: "Payment already exists",
            trackingId,
          });
        }

        await logTracking(trackingId, "payment successful");

        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentStatus: "Paid",
              deliveryStatus: "pending-pickup",
            },
          }
        );

        const paymentRecord = {
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelName: session.metadata.parcelName,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId,
        };

        await paymentCollection.insertOne(paymentRecord);

        res.send({
          success: true,
          trackingId,
          paymentRecord,
        });
      } catch (err) {
        res.status(500).send({ error: "Payment processing failed" });
      }
    });

    // =================
    // Payment History
    // =================
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;

        if (email !== req.decode_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
      }

      const result = await paymentCollection.find(query).toArray();
      res.send(result);
    });

    // =====================
    // CRUD: PARCELS
    // =====================
    app.get("/parcelsDelivered", async (req, res) => {
      const { email, deliveryStatus } = req.query;

      const query = {
        deliveryStatus,
        riderEmail: email,
      };

      const result = await parcelsCollection.find(query).toArray();
      res.send(result);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const filter = { _id: new ObjectId(req.params.id) };
      const { trackingId, deliveryStatus, riderId } = req.body;

      await parcelsCollection.updateOne(filter, {
        $set: { deliveryStatus },
      });

      logTracking(trackingId, deliveryStatus);

      if (deliveryStatus === "delivered") {
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { workStatus: "available" } }
        );
      }

      res.send({ success: true });
    });

    app.patch("/parcels/:id", async (req, res) => {
      const { trackingId, parcelId, riderId, riderName, riderEmail } = req.body;

      await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        {
          $set: {
            deliveryStatus: "delivery-assigned",
            riderId,
            riderName,
            riderEmail,
          },
        }
      );

      await ridersCollection.updateOne(
        { _id: new ObjectId(riderId) },
        { $set: { workStatus: "in_delivery" } }
      );

      logTracking(trackingId, "Driver-assigned");

      res.send({ success: true });
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();

      const result = await parcelsCollection.insertOne(parcel);

      const trackingId = generateTrackingIdSecure();
      logTracking(trackingId, "parcelCreated");

      res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { deliveryStatus, email } = req.query;

      if (deliveryStatus) query.deliveryStatus = deliveryStatus;
      if (email) query.senderEmail = email;

      const results = await parcelsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(results);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;

      const query = {};
      if (riderEmail) query.riderEmail = riderEmail;
      if (deliveryStatus) query.deliveryStatus = { $nin: ["delivered"] };

      const result = await parcelsCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Tracking API
    app.get("/trackings/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;
      const result = await trackingCollection.find({ trackingId }).toArray();
      res.send(result);
    });
  } finally {
  }
}

run().catch(console.dir);

module.exports = app;

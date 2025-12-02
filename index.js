const express = require("express");
require("dotenv").config();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin
const admin = require("firebase-admin");
const serviceAccount = require("./zip-shift-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------------------------
// Tracking ID Generator
// ---------------------------
function generateTrackingIdSecure() {
  const prefix = "TRK";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

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

    req.decode_email = decode.email; // FIXED: save decoded email
    next();
  } catch (err) {
    return res.status(403).send({ message: "invalid or expired token" });
  }
};

// ---------------------------
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
    await client.connect();
    console.log("Connected to MongoDB successfully!");

    const db = client.db("zap_shift");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");

    // ===========
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

    // ============
    // Riders api
    // ===============
    // app.pa
    // This is for approve or reject rides
    app.patch("/riders/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status: status,
          workStatus:'available'
        },
      };
      const result = await ridersCollection.updateOne(query, update);
      if (status === "approved") {
        const email = req.body.email;
        const query = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await usersCollection.updateOne(query, updateUser);
      }
      res.send(result);
    });
    app.post("/riders", async (req, res) => {
      const riders = req.body;
      riders.status = "pending";
      riders.createdAt = new Date();
      const result = await ridersCollection.insertOne(riders);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const query = {};
      const{status,district,workStatus}=req.query
      if (status) {
        query.status = status;
      }
      if(district){
        query.district=district
      }
      if(workStatus){

        query.workStatus=workStatus
      }
      const result = await ridersCollection.find(query).toArray();
      res.send(result);
    });
    // ============
    // Users api
    // ===============
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();

      res.send(result);
    });
    app.post("/users", async (req, res) => {
      const user = req.body;

      (user.role = "user"), (user.createdAt = new Date()), (email = user.email);
      const exist = await usersCollection.findOne({ email });

      if (exist) {
        return res.send({ message: "already available this user" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    // This api is for make admin
    app.patch("/user/:id", verifyFBtoken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const userInfo = req.body;
      const filter = { _id: new ObjectId(id) };
      const update = {
        $set: {
          role: userInfo.role,
        },
      };
      const result = await usersCollection.updateOne(filter, update);
      res.send(result);
    });
    // THis for see my parcels
    app.get("/users/:email/role", verifyFBtoken, async (req, res) => {
      const email = req.params.email;
      const filter = { email };
      const result = await usersCollection.findOne(filter);
      res.send({ role: result?.role || "user" });
    });

    // ===========================
    // STRIPE CHECKOUT SESSION
    // ===========================
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;
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
        console.log(error);
        res.status(400).send({ error: error.message });
      }
    });

    // ===========================
    // PAYMENT SUCCESS
    // ===========================
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const parcelId = session.metadata.parcelId;

          const trackingId = generateTrackingIdSecure();

          const update = {
            $set: {
              paymentStatus: "Paid",
              trackingId: trackingId,
              deliveryStatus: "pending-pickup",
            },
          };

          const transactionId = session.payment_intent;
          const query = { transactionId: transactionId };
          const paymentExist = await paymentCollection.findOne(query);

          if (paymentExist) {
            return res.send({ message: "already exist" });
          }

          const modifyParcel = await parcelsCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            update
          );

          const paymentRecord = {
            amount: session.amount_total / 100,
            transactionId: session.payment_intent,
            currency: session.currency,
            customerEmail: session.customer_email,
            parcelName: session.metadata.parcelName,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
            trackingId: trackingId,
          };

          const savePayment = await paymentCollection.insertOne(paymentRecord);

          return res.send({
            success: true,
            transactionId: session.payment_intent,
            trackingId,
            modifyParcel,
            paymentRecord: savePayment,
          });
        }

        res.status(400).send({ error: "Payment not completed" });
      } catch (err) {
        console.log(err);
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

        // FIXED: check email correctly
        if (email !== req.decode_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
      }

      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // =====================
    // CRUD: PARCELS
    // =====================

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });
    // app.get('/parcels/')

    app.get("/parcels", async (req, res) => {
      const query = {};
      console.log(req.query);
      const { deliveryStatus } = req.query;
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const { email } = req.query;

      if (email) query.senderEmail = email;

      const results = await parcelsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(results);
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
  } finally {
    // Do not close client if using continuous server
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

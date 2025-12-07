const express = require("express");
require("dotenv").config();
const cors = require("cors");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Firebase Admin
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-adminsdk.json");

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

    req.decode_email = decode.email; // 
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
    await client.connect();
    console.log("Connected to MongoDB successfully!");
    // ==================================
    const db = client.db("Chellange_Hive");

    const usersCollection = db.collection("users");

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
  } finally {
   
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

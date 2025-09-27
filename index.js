const express = require("express");
const multer = require("multer");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
require("dotenv").config();

const app = express();

// Load env variables
const PORT = process.env.PORT || 3000;
const UPLOAD_FOLDER = process.env.UPLOAD_FOLDER || "uploads";
const BASE_URL = process.env.BASE_URL;

// Enable CORS
app.use(cors());

// Serve static files from uploads folder
app.use(`/${UPLOAD_FOLDER}`, express.static(UPLOAD_FOLDER));

// Multer Storage Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_FOLDER);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueName + path.extname(file.originalname));
  },
});

// File type validation (optional)
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif/;
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimetype = allowedTypes.test(file.mimetype);
  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed (jpg, jpeg, png, gif)"));
  }
};

// Initialize multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Test route
app.get("/", (req, res) => {
  res.send("Image Upload Server is Running 🚀");
});

// Single Image Upload
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const fileUrl = `${BASE_URL}/${UPLOAD_FOLDER}/${req.file.filename}`;
  res.json({
    message: "Image uploaded successfully!",
    filename: req.file.filename,
    url: fileUrl,
  });
});

// Multiple Image Upload
app.post("/upload-multiple", upload.array("images", 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  const filesInfo = req.files.map((file) => ({
    filename: file.filename,
    url: `${BASE_URL}/${UPLOAD_FOLDER}/${file.filename}`,
  }));

  res.json({
    message: "Images uploaded successfully!",
    files: filesInfo,
  });
});

app.get("/images", (req, res) => {
  fs.readdir(UPLOAD_FOLDER, (err, files) => {
    if (err) {
      console.error("Failed to read uploads directory", err);
      return res.status(500).json({ error: "Failed to load images" });
    }

    // Filter only image files (basic filter)
    const images = files.filter((file) =>
      /\.(jpe?g|png|gif|webp)$/i.test(file)
    );

    // Build response array with filename + public URL
    const imageData = images.map((filename) => ({
      filename,
      url: `${req.protocol}://${req.get("host")}/uploads/${filename}`,
    }));

    res.json(imageData);
  });
});
// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on ${BASE_URL}`);
});

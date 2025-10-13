const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

require("dotenv").config();

const app = express();

// Load env variables
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const jwt_secret = process.env.JWT_SECRET;

// Enable CORS
app.use(cors({ origin: "*" }));
// Parse JSON bodies - THIS IS CRITICAL!
app.use(express.json());

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));
// Multer Storage Setup - using memory storage for cloud upload
const storage = multer.memoryStorage();

// File type validation
const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp/;
  const ext = allowed.test(file.originalname.split(".").pop().toLowerCase());
  const mime = allowed.test(file.mimetype);
  ext && mime ? cb(null, true) : cb(new Error("Only image files are allowed"));
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Helper function to upload to Supabase
const uploadToSupabase = async (file) => {
  const id = crypto.randomUUID();
  const ext = file.originalname.split(".").pop();
  const filename = `${id}.${ext}`;

  const { error } = await supabase.storage
    .from("uploads")
    .upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from("uploads")
    .getPublicUrl(filename);
  return {
    id,
    filename,
    url: urlData.publicUrl,
    size: file.size,
    mimetype: file.mimetype,
  };
};
// Error handler for multer
const handleUploadError = (err, req, res) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large. Max 10MB." });
  }
  if (err.message.includes("Only image files")) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Upload failed" });
};
// Test route
app.get("/", (req, res) => {
  res.send("Image Upload Server is Running 🚀");
});

// Single Image Upload
app.post(
  "/upload",
  upload.single("image"),
  handleUploadError,
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const result = await uploadToSupabase(req.file);
      const fileUrl = BASE_URL
        ? `${BASE_URL}/file/${result.filename}`
        : result.url;
      res.json({ message: "Uploaded!", ...result, url: fileUrl });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Failed to upload image" });
    }
  }
);
// Multiple Image Upload
app.post(
  "/upload-multiple",
  upload.array("images", 10),
  handleUploadError,
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const uploads = await Promise.all(
        req.files.map((file) => uploadToSupabase(file))
      );
      const files = uploads.map((f) => ({
        id: f.id,
        filename: f.filename,
        url: BASE_URL ? `${BASE_URL}/file/${f.filename}` : f.url,
      }));

      res.json({ message: "Uploaded successfully", files });
    } catch (err) {
      console.error("Multiple upload error:", err);
      res.status(500).json({ error: "Failed to upload images" });
    }
  }
);

// Get all images
app.get("/images", async (req, res) => {
  try {
    const { data: files, error } = await supabase.storage
      .from("uploads")
      .list("", {
        limit: 100,
        sortBy: { column: "created_at", order: "desc" },
      });

    if (error) throw error;

    const images = files.filter((file) =>
      /\.(jpe?g|png|gif|webp)$/i.test(file.name)
    );
    const result = images.map((file) => {
      const { data: urlData } = supabase.storage
        .from("uploads")
        .getPublicUrl(file.name);
      return {
        id: file.name.split(".")[0],
        filename: file.name,
        url: urlData.publicUrl,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Fetch images error:", err);
    res.status(500).json({ error: "Failed to load images" });
  }
});

// Optional: Serve files through your API (if you want custom URLs)
app.get("/file/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const { data, error } = await supabase.storage
      .from("uploads")
      .download(filename);
    if (error) return res.status(404).json({ error: "File not found" });

    const buffer = await data.arrayBuffer();
    res.set("Content-Type", "image/jpeg");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Serve error:", err);
    res.status(500).json({ error: "Failed to serve file" });
  }
});

// Delete image by filename
app.delete("/images/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: files } = await supabase.storage
      .from("uploads")
      .list("", { search: id });
    const file = files.find((f) => f.name.startsWith(id + "."));
    if (!file) return res.status(404).json({ error: "File not found" });

    await supabase.storage.from("uploads").remove([file.name]);
    res.json({ message: "Deleted", filename: file.name });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

// JWT auth middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Decode and verify JWT token
    const decoded = jwt.verify(token, jwt_secret);
    const userId = decoded.userId;

    // Fetch user from Supabase table by userId
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, username, full_name, role")
      .eq("id", userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: "Invalid token or user not found" });
    }

    req.user = user; // Attach user object to request
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid token" });
  }
};

// Register
app.post("/register", async (req, res) => {
  try {
    const { email, username, full_name, role, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const allowedRoles = ["user", "admin", "moderator"];
    const assignedRole = allowedRoles.includes(role) ? role : "user";

    // Check if email already exists
    const { data: existing, error: existingError } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (existing) {
      return res.status(409).json({ error: "Email already exists" });
    }
    if (existingError && existingError.code !== "PGRST116") {
      return res.status(400).json({ error: existingError.message });
    }

    // Hash the password before saving
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Insert new user record with hashed password
    const { data, error } = await supabase
      .from("users")
      .insert([
        {
          username: username || email.split("@")[0],
          full_name: full_name || "",
          email: email,
          role: assignedRole,
          password: password_hash,
        },
      ])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({
      message: "User record created",
      user: data[0],
    });
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(email, password);
    // 1. Find user by email in Supabase table
    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, username, full_name, role, password")
      .eq("email", email)
      .single();
    if (!user || error) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // 2. Compare password using bcrypt
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // 3. Create JWT token
    const token = jwt.sign({ userId: user.id }, jwt_secret, {
      expiresIn: "1h",
    });

    // 4. Respond with token
    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

// Get current user profile
app.get("/me", authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("id, username, full_name, avatar_url, role, bio, updated_at")
      .eq("id", req.user.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Logout (client-side JWT deletion)
app.post("/logout", authenticateToken, (req, res) => {
  res.json({ message: "Logged out successfully" });
});
// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on ${BASE_URL || `http://localhost:${PORT}`}`);
});

module.exports = app;

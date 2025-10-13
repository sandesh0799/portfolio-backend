const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const app = express();

// Load env variables
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Enable CORS
app.use(cors({ origin: "*" }));
app.use(express.json());
// Multer Storage Setup - using memory storage for cloud upload
const storage = multer.memoryStorage();

// File type validation
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(
    file.originalname.split(".").pop().toLowerCase()
  );
  const mimetype = /jpeg|jpg|png|gif|webp/.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed (jpg, jpeg, png, gif, webp)"));
  }
};

// Initialize multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Helper function to upload to Supabase
const uploadToSupabase = async (file) => {
  const id = crypto.randomUUID();
  const ext = file.originalname.split(".").pop();
  const fileName = `${id}.${ext}`;

  const { data, error } = await supabase.storage
    .from("uploads")
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) {
    throw error;
  }

  const { data: urlData } = supabase.storage
    .from("uploads")
    .getPublicUrl(fileName);

  return {
    id,
    filename: fileName,
    url: urlData.publicUrl,
    size: file.size,
    mimetype: file.mimetype,
  };
};

// Error handler for multer
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "File too large. Maximum size is 10MB." });
    }
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
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const result = await uploadToSupabase(req.file);
      const fileUrl = BASE_URL
        ? `${BASE_URL}/file/${result.filename}`
        : result.url;

      res.json({
        message: "Image uploaded successfully!",
        id: result.id,
        filename: result.filename,
        url: fileUrl,
      });
    } catch (error) {
      console.error("Upload error:", error);
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

      const uploadPromises = req.files.map((file) => uploadToSupabase(file));
      const results = await Promise.all(uploadPromises);

      const filesInfo = results.map((result) => ({
        id: result.id,
        filename: result.filename,
        url: BASE_URL ? `${BASE_URL}/file/${result.filename}` : result.url,
      }));

      res.json({
        message: "Images uploaded successfully!",
        files: filesInfo,
      });
    } catch (error) {
      console.error("Multiple upload error:", error);
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

    if (error) {
      throw error;
    }

    // Filter only image files
    const images = files.filter((file) =>
      /\.(jpe?g|png|gif|webp)$/i.test(file.name)
    );

    // Build response array with id, filename + public URL
    const imageData = images.map((file) => {
      const { data: urlData } = supabase.storage
        .from("uploads")
        .getPublicUrl(file.name);

      return {
        id: file.name.split(".")[0], // The UUID part
        filename: file.name,
        url: urlData.publicUrl,
      };
    });

    res.json(imageData);
  } catch (error) {
    console.error("Failed to read images", error);
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

    if (error) {
      return res.status(404).json({ error: "File not found" });
    }

    // Get file info to set proper headers
    const { data: fileList } = await supabase.storage
      .from("uploads")
      .list("", { search: filename });

    const fileInfo = fileList?.find((f) => f.name === filename);

    res.set({
      "Content-Type": fileInfo?.metadata?.mimetype || "image/jpeg",
      "Content-Length": data.size,
      "Cache-Control": "public, max-age=31536000",
    });

    const buffer = await data.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("Error serving file:", error);
    res.status(500).json({ error: "Failed to serve file" });
  }
});

// Delete image by filename
app.delete("/images/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "ID is required" });
    }

    // List files that start with the given id
    const { data: files, error: listError } = await supabase.storage
      .from("uploads")
      .list("", { search: id });

    if (listError) {
      console.error("Error listing files:", listError);
      return res.status(500).json({ error: "Failed to search files" });
    }

    // Find the exact file where filename starts with the id + '.'
    const fileToDelete = files.find((file) => file.name.startsWith(id + "."));

    if (!fileToDelete) {
      return res.status(404).json({ error: "File not found" });
    }

    // Delete the file by full filename
    const { error: deleteError } = await supabase.storage
      .from("uploads")
      .remove([fileToDelete.name]);

    if (deleteError) {
      console.error("Delete error:", deleteError);
      return res.status(500).json({ error: "Failed to delete image" });
    }

    res.json({
      message: "Image deleted successfully",
      id: id,
      filename: fileToDelete.name,
    });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete image" });
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

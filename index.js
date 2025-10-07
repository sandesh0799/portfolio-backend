const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();

// Load env variables
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Enable CORS
app.use(cors());

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
  const id = uuidv4();
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

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on ${BASE_URL || `http://localhost:${PORT}`}`);
});

module.exports = app;

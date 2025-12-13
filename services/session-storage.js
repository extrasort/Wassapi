const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase environment variables for session storage!');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const BUCKET_NAME = 'whatsapp-sessions';

/**
 * Ensure the Supabase storage bucket exists
 */
async function ensureBucketExists() {
  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      console.error('Error listing buckets:', listError);
      return false;
    }

    const bucketExists = buckets.some(bucket => bucket.name === BUCKET_NAME);
    if (!bucketExists) {
      console.log(`📦 Creating storage bucket: ${BUCKET_NAME}`);
      const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: false,
        fileSizeLimit: 10485760, // 10MB max file size
      });
      
      if (createError) {
        console.error(`❌ Error creating bucket ${BUCKET_NAME}:`, createError);
        return false;
      }
      console.log(`✅ Bucket ${BUCKET_NAME} created successfully`);
    }
    return true;
  } catch (error) {
    console.error('❌ Error ensuring bucket exists:', error);
    return false;
  }
}

/**
 * Backup session data from local filesystem to Supabase Storage
 */
async function backupSession(sessionId) {
  try {
    await ensureBucketExists();
    
    // LocalAuth uses clientId as the directory name directly
    // We pass sessionId as clientId, so directory is .wwebjs_auth/{sessionId}
    const sessionDir = path.join(process.cwd(), '.wwebjs_auth', sessionId);
    
    if (!fs.existsSync(sessionDir)) {
      console.log(`⚠️ Session directory does not exist: ${sessionDir}`);
      return false;
    }

    // Create a zip/tar of the session directory
    // For simplicity, we'll upload individual files
    const files = getAllFiles(sessionDir);
    
    for (const file of files) {
      const relativePath = path.relative(sessionDir, file);
      const fileBuffer = fs.readFileSync(file);
      
      const storagePath = `${sessionId}/${relativePath}`;
      
      const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, fileBuffer, {
          contentType: 'application/octet-stream',
          upsert: true, // Overwrite if exists
        });

      if (error) {
        console.error(`❌ Error uploading ${storagePath}:`, error);
        return false;
      }
    }
    
    console.log(`✅ Session ${sessionId} backed up to Supabase Storage`);
    return true;
  } catch (error) {
    console.error(`❌ Error backing up session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Restore session data from Supabase Storage to local filesystem
 */
async function restoreSession(sessionId) {
  try {
    await ensureBucketExists();
    
    // LocalAuth uses clientId as the directory name directly
    // We pass sessionId as clientId, so directory is .wwebjs_auth/{sessionId}
    const sessionDir = path.join(process.cwd(), '.wwebjs_auth', sessionId);
    
    // List all files in the storage bucket for this session
    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET_NAME)
      .list(sessionId);
    
    if (listError) {
      console.error(`❌ Error listing files for session ${sessionId}:`, listError);
      return false;
    }
    
    if (!files || files.length === 0) {
      console.log(`⚠️ No backup found for session ${sessionId} in storage`);
      return false;
    }
    
    // Ensure session directory exists
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // Download and restore each file
    for (const file of files) {
      const storagePath = `${sessionId}/${file.name}`;
      const localPath = path.join(sessionDir, file.name);
      
      // Ensure parent directory exists
      const parentDir = path.dirname(localPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      
      const { data, error: downloadError } = await supabase.storage
        .from(BUCKET_NAME)
        .download(storagePath);
      
      if (downloadError) {
        console.error(`❌ Error downloading ${storagePath}:`, downloadError);
        continue;
      }
      
      // Convert blob to buffer and write to file
      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(localPath, buffer);
    }
    
    console.log(`✅ Session ${sessionId} restored from Supabase Storage`);
    return true;
  } catch (error) {
    console.error(`❌ Error restoring session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Recursively get all files in a directory
 */
function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
    } else {
      arrayOfFiles.push(filePath);
    }
  });

  return arrayOfFiles;
}

/**
 * Delete session data from Supabase Storage
 */
async function deleteSession(sessionId) {
  try {
    await ensureBucketExists();
    
    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET_NAME)
      .list(sessionId);
    
    if (listError || !files || files.length === 0) {
      return true; // Nothing to delete
    }
    
    const pathsToDelete = files.map(file => `${sessionId}/${file.name}`);
    
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove(pathsToDelete);
    
    if (error) {
      console.error(`❌ Error deleting session ${sessionId} from storage:`, error);
      return false;
    }
    
    console.log(`✅ Session ${sessionId} deleted from Supabase Storage`);
    return true;
  } catch (error) {
    console.error(`❌ Error deleting session ${sessionId}:`, error);
    return false;
  }
}

module.exports = {
  backupSession,
  restoreSession,
  deleteSession,
  ensureBucketExists,
};


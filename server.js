const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const busboy = require("busboy");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { promisify } = require('util');

const app = express();

// =======================
// 서버 설정
// =======================
const myHost = "172.20.10.8";
const PORT = 8011;

// =======================
// 업로드 폴더
// =======================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
    console.log("✅ uploads 폴더 생성 완료");
}

// =======================
// SQLite (sqlite3)
// =======================
const dbPath = path.join(__dirname, "media.db");
let db;

try {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error("❌ DB 연결 실패:", err.message);
            process.exit(1);
        }
        console.log("✅ SQLite 데이터베이스 연결 성공 (sqlite3)");
    });
} catch (err) {
    console.error("❌ DB 연결 실패:", err.message);
    process.exit(1);
}

// DB 메서드를 Promise로 변환
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

// 테이블 초기화
const initDatabase = async () => {
    try {
        // file_storage 테이블
        await dbRun(`
            CREATE TABLE IF NOT EXISTS file_storage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_hash TEXT UNIQUE NOT NULL,
                saved_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                file_type TEXT NOT NULL,
                ref_count INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // uploaded_media 테이블
        await dbRun(`
            CREATE TABLE IF NOT EXISTS uploaded_media (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                storage_id INTEGER NOT NULL,
                original_name TEXT NOT NULL,
                album_name TEXT DEFAULT 'Default',
                album_path TEXT,
                uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (storage_id) REFERENCES file_storage(id) ON DELETE CASCADE
            )
        `);

        // 인덱스 생성
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_file_hash ON file_storage(file_hash)`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_storage_id ON uploaded_media(storage_id)`);
        await dbRun(`CREATE INDEX IF NOT EXISTS idx_album_name ON uploaded_media(album_name)`);

        console.log("✅ 참조 카운팅 테이블 준비 완료");
    } catch (err) {
        console.error("❌ 테이블 초기화 실패:", err.message);
        process.exit(1);
    }
};

initDatabase();

// =======================
// 미들웨어
// =======================
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use('/uploads', express.static(uploadDir));

app.use((req, res, next) => {
    console.log('\n========================================');
    console.log(`[${new Date().toLocaleString("ko-KR")}]`);
    console.log(`요청: ${req.method} ${req.url}`);
    console.log('========================================');
    next();
});

// =======================
// 유틸
// =======================
function getFileType(mimeType, filename = "") {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";

    if (mimeType === "application/octet-stream" && filename) {
        const ext = path.extname(filename).toLowerCase();
        const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".heif"];
        if (imageExts.includes(ext)) return "image";
        const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v"];
        if (videoExts.includes(ext)) return "video";
    }

    return "unknown";
}

function guessMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
        ".heic": "image/heic", ".heif": "image/heif",
        ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska", ".webm": "video/webm",
    };
    return mimeTypes[ext] || "application/octet-stream";
}

function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function calculateHash(buffer) {
    return crypto.createHash("md5").update(buffer).digest("hex");
}

function sanitizeFolderName(name) {
    return name.replace(/[^a-zA-Z0-9가-힣._-]/g, "_");
}

function ensureAlbumFolder(albumName) {
    const safeName = sanitizeFolderName(albumName);
    const albumPath = path.join(uploadDir, safeName);
    if (!fs.existsSync(albumPath)) {
        fs.mkdirSync(albumPath, { recursive: true });
        console.log(`📁 앨범 폴더 생성: ${safeName}`);
    }
    return { safeName, albumPath };
}

// =======================
// 미디어 업로드 (참조 카운팅)
// =======================
app.post("/api/upload/media", (req, res) => {
    console.log("🔵 [UPLOAD START] 업로드 요청 시작");

    const bb = busboy({
        headers: req.headers,
        limits: { fileSize: 200 * 1024 * 1024 },
    });

    let fileData;
    let fileInfo;
    let fileType;
    let albumName = "Default";
    let hasError = false;
    let errorMessage = "";

    bb.on("field", (name, val) => {
        if (name === "album") {
            albumName = val || "Default";
            console.log(`📁 [ALBUM] 앨범: ${albumName}`);
        }
    });

    bb.on("file", (fieldname, file, info) => {
        const { filename, mimeType } = info;
        const decodedFilename = Buffer.from(filename, "latin1").toString("utf8");
        
        fileType = getFileType(mimeType, decodedFilename);
        if (fileType === "unknown") {
            hasError = true;
            errorMessage = `지원하지 않는 파일 형식: ${mimeType}`;
            file.resume();
            return;
        }

        let actualMimeType = mimeType;
        if (mimeType === "application/octet-stream") {
            actualMimeType = guessMimeType(decodedFilename);
        }

        const chunks = [];
        file.on("data", (chunk) => chunks.push(chunk));
        file.on("error", (err) => {
            hasError = true;
            errorMessage = `파일 읽기 오류: ${err.message}`;
        });
        file.on("end", () => {
            fileData = Buffer.concat(chunks);
            fileInfo = {
                originalName: decodedFilename,
                mimeType: actualMimeType,
                size: fileData.length,
            };
        });
    });

    bb.on("finish", async () => {
        if (hasError || !fileData) {
            return res.status(400).json({
                success: false,
                message: errorMessage || "파일 업로드 실패",
            });
        }

        const fileHash = calculateHash(fileData);
        console.log(`🔐 [HASH] ${fileHash}`);

        try {
            // 트랜잭션 시작
            await dbRun("BEGIN TRANSACTION");

            // 1. file_storage에서 해시 확인
            let storage = await dbGet(
                "SELECT * FROM file_storage WHERE file_hash = ?",
                [fileHash]
            );

            if (storage) {
                // 기존 파일 존재 - 참조 카운트 증가
                console.log(`♻️ [REUSE] 기존 파일 재사용 (ref_count: ${storage.ref_count} → ${storage.ref_count + 1})`);
                
                await dbRun(
                    "UPDATE file_storage SET ref_count = ref_count + 1 WHERE id = ?",
                    [storage.id]
                );
                
                storage.ref_count += 1;
            } else {
                // 새 파일 - 물리적으로 저장
                console.log(`💾 [NEW FILE] 새 파일 저장`);
                
                const { safeName: safeAlbumName } = ensureAlbumFolder(albumName);
                const timestamp = Date.now();
                const safeName = fileInfo.originalName.replace(/[^a-zA-Z0-9가-힣._-]/g, "_");
                const savedName = `${timestamp}_${safeName}`;
                const relativePath = path.join(safeAlbumName, savedName);
                const filePath = path.join(uploadDir, relativePath);

                fs.writeFileSync(filePath, fileData);

                const result = await dbRun(
                    `INSERT INTO file_storage
                     (file_hash, saved_name, file_path, file_size, mime_type, file_type, ref_count)
                     VALUES (?, ?, ?, ?, ?, ?, 1)`,
                    [fileHash, savedName, filePath, fileInfo.size, fileInfo.mimeType, fileType]
                );

                storage = {
                    id: result.lastID,
                    file_hash: fileHash,
                    saved_name: savedName,
                    file_path: filePath,
                    file_size: fileInfo.size,
                    mime_type: fileInfo.mimeType,
                    file_type: fileType,
                    ref_count: 1,
                };
            }

            // 2. uploaded_media에 메타데이터 추가
            const { safeName: safeAlbumName } = ensureAlbumFolder(albumName);
            const albumPath = path.join(safeAlbumName, storage.saved_name);
            
            const mediaResult = await dbRun(
                `INSERT INTO uploaded_media
                 (storage_id, original_name, album_name, album_path)
                 VALUES (?, ?, ?, ?)`,
                [storage.id, fileInfo.originalName, albumName, albumPath]
            );

            // 트랜잭션 커밋
            await dbRun("COMMIT");

            console.log(`✅ [SUCCESS] 업로드 완료`);
            console.log(`   - Storage ID: ${storage.id} (ref_count: ${storage.ref_count})`);
            console.log(`   - Media ID: ${mediaResult.lastID}`);

            res.json({
                success: true,
                data: {
                    id: mediaResult.lastID,
                    storageId: storage.id,
                    originalName: fileInfo.originalName,
                    savedName: storage.saved_name,
                    fileType,
                    fileHash,
                    albumName,
                    albumPath: albumPath,
                    size: fileInfo.size,
                    refCount: storage.ref_count,
                    url: `http://${myHost}:${PORT}/uploads/${encodeURIComponent(albumPath)}`,
                },
            });
        } catch (err) {
            // 트랜잭션 롤백
            await dbRun("ROLLBACK");
            console.error(`❌ [DB ERROR]`, err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    req.pipe(bb);
});

// =======================
// 해시 목록 (file_storage 기준)
// =======================
app.get("/api/upload/hashes", async (req, res) => {
    try {
        const rows = await dbAll(
            "SELECT file_hash FROM file_storage ORDER BY created_at DESC"
        );
        
        const hashes = rows.map(row => row.file_hash);
        
        res.json({
            success: true,
            count: hashes.length,
            hashes: hashes,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =======================
// 미디어 목록 (JOIN으로 가져오기)
// =======================
app.get("/api/upload/media", async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type;
    const album = req.query.album;

    let sql = `
        SELECT 
            m.id as media_id,
            m.original_name,
            m.album_name,
            m.album_path,
            m.uploaded_at,
            s.id as storage_id,
            s.file_hash,
            s.saved_name,
            s.file_size,
            s.mime_type,
            s.file_type,
            s.ref_count
        FROM uploaded_media m
        JOIN file_storage s ON m.storage_id = s.id
        WHERE 1=1
    `;
    const params = [];

    if (type) {
        sql += " AND s.file_type = ?";
        params.push(type);
    }

    if (album) {
        sql += " AND m.album_name = ?";
        params.push(album);
    }

    sql += " ORDER BY m.uploaded_at DESC LIMIT ?";
    params.push(limit);

    try {
        const rows = await dbAll(sql, params);

        res.json({
            success: true,
            count: rows.length,
            data: rows.map(r => ({
                id: r.media_id,
                storageId: r.storage_id,
                originalName: r.original_name,
                savedName: r.saved_name,
                albumName: r.album_name,
                albumPath: r.album_path,
                fileSize: r.file_size,
                mimeType: r.mime_type,
                fileType: r.file_type,
                fileHash: r.file_hash,
                refCount: r.ref_count,
                uploadedAt: r.uploaded_at,
                url: `http://${myHost}:${PORT}/uploads/${encodeURIComponent(r.album_path)}`,
                sizeFormatted: formatFileSize(r.file_size),
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =======================
// 앨범 목록
// =======================
app.get("/api/upload/albums", async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT 
                m.album_name,
                COUNT(*) as count,
                SUM(s.file_size) as total_size,
                MAX(m.uploaded_at) as last_updated
            FROM uploaded_media m
            JOIN file_storage s ON m.storage_id = s.id
            GROUP BY m.album_name
            ORDER BY last_updated DESC
        `);

        res.json({
            success: true,
            count: rows.length,
            albums: rows.map(r => ({
                name: r.album_name,
                fileCount: r.count,
                totalSize: r.total_size,
                totalSizeFormatted: formatFileSize(r.total_size),
                lastUpdated: r.last_updated,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =======================
// 전체 삭제
// =======================
app.delete('/api/upload/media/all', async (req, res) => {
    console.log('🗑️ [DELETE ALL] 전체 삭제 요청');
    
    try {
        await dbRun("BEGIN TRANSACTION");

        // 1. 모든 파일 경로 가져오기
        const files = await dbAll("SELECT DISTINCT file_path FROM file_storage");
        
        // 2. 물리적 파일 삭제
        let deletedFiles = 0;
        for (const file of files) {
            if (fs.existsSync(file.file_path)) {
                try {
                    fs.unlinkSync(file.file_path);
                    deletedFiles++;
                } catch (err) {
                    console.error(`파일 삭제 실패: ${file.file_path}`, err);
                }
            }
        }
        
        // 3. DB에서 모든 레코드 삭제
        const mediaDeleted = await dbRun("DELETE FROM uploaded_media");
        const storageDeleted = await dbRun("DELETE FROM file_storage");
        
        await dbRun("COMMIT");

        console.log(`🗑️ 삭제 완료:`);
        console.log(`   - 물리적 파일: ${deletedFiles}개`);
        console.log(`   - uploaded_media: ${mediaDeleted.changes}개`);
        console.log(`   - file_storage: ${storageDeleted.changes}개`);
        
        res.json({
            success: true,
            message: "모든 데이터가 삭제되었습니다",
            stats: {
                deletedFiles,
                deletedMedia: mediaDeleted.changes,
                deletedStorage: storageDeleted.changes,
            },
        });
    } catch (err) {
        await dbRun("ROLLBACK");
        console.error("전체 삭제 오류:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =======================
// 미디어 삭제 (참조 카운팅)
// =======================
app.delete('/api/upload/media/:id', async (req, res) => {
    const mediaId = req.params.id;

    try {
        await dbRun("BEGIN TRANSACTION");

        // 1. uploaded_media에서 정보 가져오기
        const media = await dbGet(
            "SELECT * FROM uploaded_media WHERE id = ?",
            [mediaId]
        );
        
        if (!media) {
            await dbRun("ROLLBACK");
            return res.status(404).json({ success: false, message: "파일을 찾을 수 없습니다" });
        }

        // 2. file_storage 정보 가져오기
        const storage = await dbGet(
            "SELECT * FROM file_storage WHERE id = ?",
            [media.storage_id]
        );

        // 3. uploaded_media에서 레코드 삭제
        await dbRun("DELETE FROM uploaded_media WHERE id = ?", [mediaId]);
        console.log(`🗑️ [DELETE MEDIA] ID: ${mediaId}, 파일: ${media.original_name}`);

        // 4. file_storage의 ref_count 감소
        const newRefCount = storage.ref_count - 1;
        
        if (newRefCount <= 0) {
            // 참조가 0이 되면 실제 파일 삭제
            if (fs.existsSync(storage.file_path)) {
                fs.unlinkSync(storage.file_path);
                console.log(`🗑️ [DELETE FILE] 실제 파일 삭제: ${storage.file_path}`);
            }
            
            await dbRun("DELETE FROM file_storage WHERE id = ?", [storage.id]);
            console.log(`🗑️ [DELETE STORAGE] Storage ID: ${storage.id} (ref_count: 0)`);
        } else {
            // 아직 참조가 남아있으면 ref_count만 감소
            await dbRun(
                "UPDATE file_storage SET ref_count = ? WHERE id = ?",
                [newRefCount, storage.id]
            );
            console.log(`📊 [UPDATE REF] Storage ID: ${storage.id} (ref_count: ${storage.ref_count} → ${newRefCount})`);
        }

        await dbRun("COMMIT");

        res.json({ 
            success: true, 
            deletedFile: newRefCount <= 0,
            remainingReferences: newRefCount > 0 ? newRefCount : 0,
        });
    } catch (err) {
        await dbRun("ROLLBACK");
        console.error("삭제 오류:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =======================
// 통계 정보
// =======================
app.get('/api/upload/stats', async (req, res) => {
    try {
        const mediaCount = await dbGet("SELECT COUNT(*) as count FROM uploaded_media");
        const storageCount = await dbGet("SELECT COUNT(*) as count FROM file_storage");
        const imageCount = await dbGet("SELECT COUNT(*) as count FROM file_storage WHERE file_type = 'image'");
        const videoCount = await dbGet("SELECT COUNT(*) as count FROM file_storage WHERE file_type = 'video'");
        const totalSize = await dbGet("SELECT SUM(file_size) as size FROM file_storage");
        const albumCount = await dbGet("SELECT COUNT(DISTINCT album_name) as count FROM uploaded_media");
        
        res.json({
            success: true,
            stats: {
                totalUploads: mediaCount.count,
                uniqueFiles: storageCount.count,
                duplicateSavings: mediaCount.count - storageCount.count,
                images: imageCount.count,
                videos: videoCount.count,
                albums: albumCount.count,
                totalSize: totalSize.size || 0,
                totalSizeFormatted: formatFileSize(totalSize.size || 0),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =======================
// 파일 해시로 확인
// =======================
app.post("/api/upload/check-hash", async (req, res) => {
    const { hash } = req.body;
    
    if (!hash) {
        return res.status(400).json({
            success: false,
            message: "해시값이 필요합니다.",
        });
    }
    
    try {
        const storage = await dbGet(
            "SELECT * FROM file_storage WHERE file_hash = ?",
            [hash]
        );
        
        res.json({
            success: true,
            exists: !!storage,
            data: storage || null,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =======================
// 루트
// =======================
app.get('/', (req, res) => {
    res.json({
        message: "미디어 업로드 API 서버 (참조 카운팅)",
        status: "running",
        features: [
            "중복 파일 자동 감지",
            "참조 카운팅으로 안전한 삭제",
            "저장 공간 효율성"
        ],
        endpoints: {
            upload: "POST /api/upload/media",
            hashes: "GET /api/upload/hashes",
            albums: "GET /api/upload/albums",
            list: "GET /api/upload/media?album=앨범명",
            checkHash: "POST /api/upload/check-hash",
            stats: "GET /api/upload/stats",
            delete: "DELETE /api/upload/media/:id",
            deleteAll: "DELETE /api/upload/media/all",
        },
    });
});

// =======================
// 서버 시작
// =======================
app.listen(PORT, myHost, () => {
    console.log(`🚀 서버 실행: http://${myHost}:${PORT}`);
    console.log('📡 참조 카운팅 시스템 활성화 (sqlite3)');
    console.log('   - 중복 파일 자동 감지');
    console.log('   - 안전한 파일 삭제');
    console.log('   - 저장 공간 최적화');
    console.log('\n📋 사용 가능한 엔드포인트:');
    console.log('   POST   /api/upload/media - 파일 업로드');
    console.log('   GET    /api/upload/hashes - 해시 목록');
    console.log('   GET    /api/upload/albums - 앨범 목록');
    console.log('   GET    /api/upload/media - 파일 목록');
    console.log('   POST   /api/upload/check-hash - 해시 확인');
    console.log('   GET    /api/upload/stats - 통계');
    console.log('   DELETE /api/upload/media/:id - 개별 삭제');
    console.log('   DELETE /api/upload/media/all - 전체 삭제');
});

// =======================
// 종료 처리
// =======================
process.on("SIGINT", () => {
    db.close((err) => {
        if (err) {
            console.error("DB 종료 오류:", err.message);
        }
        console.log("\n💾 DB 종료");
        process.exit(0);
    });
});
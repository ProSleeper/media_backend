const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const busboy = require('busboy');
const path = require('path');
const fs = require('fs');
const app = express();

// IP&PORT 설정
// const myHost = "172.20.10.8"; // 프론트엔드 config와 동일하게
const myHost = 'localhost';  // 프론트엔드 config와 동일하게
const PORT = 8011;

// 업로드 폴더 생성
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
    console.log('✅ uploads 폴더 생성 완료');
}

// SQLite 데이터베이스 연결
const dbPath = path.join(__dirname, 'media.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 데이터베이스 연결 실패:', err.message);
    } else {
        console.log('✅ SQLite 데이터베이스 연결 성공');
        initDatabase();
    }
});

// 데이터베이스 초기화 (테이블 생성)
function initDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS uploaded_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_name TEXT NOT NULL,
            saved_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER,
            mime_type TEXT,
            file_type TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('❌ 미디어 테이블 생성 실패:', err.message);
        } else {
            console.log('✅ 미디어 테이블 준비 완료');
        }
    });
}

// 미들웨어 설정
app.use(cors());
app.use(express.json({ limit: '200mb' }));  // 영상 파일을 위해 증가

// UTF-8 인코딩 설정
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

app.use('/uploads', express.static(uploadDir));

// 요청 로깅 미들웨어
app.use((req, res, next) => {
    console.log('\n========================================');
    console.log(`[${new Date().toLocaleString('ko-KR')}]`);
    console.log(`요청: ${req.method} ${req.url}`);
    console.log('========================================');
    next();
});

// 파일 타입 확인 함수
function getFileType(mimeType) {
    if (mimeType.startsWith('image/')) {
        return 'image';
    } else if (mimeType.startsWith('video/')) {
        return 'video';
    }
    return 'unknown';
}

// 미디어 업로드 API (Busboy 사용)
app.post('/api/upload/media', (req, res) => {
    console.log('\n📸🎬 미디어 업로드 요청 받음');
    console.log('----------------------------------------');

    const bb = busboy({ 
        headers: req.headers,
        limits: {
            fileSize: 200 * 1024 * 1024 // 200MB
        }
    });
    
    let fileData = null;
    let fileInfo = null;
    let fileType = null;
    let hasError = false;  // 에러 발생 여부 체크

    bb.on('file', (fieldname, file, info) => {
        const { filename, encoding, mimeType } = info;
        
        // 한글 파일명 디코딩 (latin1 -> utf8)
        const decodedFilename = Buffer.from(filename, 'latin1').toString('utf8');
        
        // 파일 타입 확인
        fileType = getFileType(mimeType);
        
        // 이미지 또는 영상 파일인지 체크
        if (fileType === 'unknown') {
            hasError = true;
            file.resume();  // 파일 스트림 소비
            return;
        }

        const fileTypeEmoji = fileType === 'image' ? '🖼️' : '🎬';
        
        console.log(`📁 파일 정보:`);
        console.log(`  - 원본 파일명: ${decodedFilename}`);
        console.log(`  - 파일 타입: ${fileTypeEmoji} ${fileType}`);
        console.log(`  - MIME 타입: ${mimeType}`);
        console.log(`  - 인코딩: ${encoding}`);

        const chunks = [];
        
        file.on('data', (chunk) => {
            chunks.push(chunk);
        });

        file.on('end', () => {
            fileData = Buffer.concat(chunks);
            fileInfo = {
                originalName: decodedFilename,
                mimeType: mimeType,
                size: fileData.length
            };
            
            const sizeKB = (fileInfo.size / 1024).toFixed(2);
            const sizeMB = (fileInfo.size / 1024 / 1024).toFixed(2);
            
            if (fileInfo.size > 1024 * 1024) {
                console.log(`  - 파일 크기: ${sizeMB} MB`);
            } else {
                console.log(`  - 파일 크기: ${sizeKB} KB`);
            }
        });

        file.on('limit', () => {
            hasError = true;
        });
    });

    bb.on('field', (name, value) => {
        console.log(`  - 필드: ${name} = ${value}`);
    });

    bb.on('finish', () => {
        // 에러가 있으면 응답하고 종료
        if (hasError) {
            if (fileType === 'unknown') {
                return res.status(400).json({
                    success: false,
                    message: '이미지 또는 영상 파일만 업로드 가능합니다.'
                });
            } else {
                return res.status(400).json({
                    success: false,
                    message: '파일 크기는 100MB를 초과할 수 없습니다.'
                });
            }
        }

        if (!fileData || !fileInfo) {
            return res.status(400).json({
                success: false,
                message: '파일이 업로드되지 않았습니다.'
            });
        }

        // 저장할 파일명: 타임스탬프 + 원본파일명
        const timestamp = Date.now();
        const sanitizedFilename = fileInfo.originalName.replace(/[^a-zA-Z0-9가-힣._-]/g, '_');
        const savedName = `${timestamp}_${sanitizedFilename}`;
        const filePath = path.join(uploadDir, savedName);

        console.log(`  - 저장 파일명: ${savedName}`);

        // 파일 저장
        try {
            fs.writeFileSync(filePath, fileData);
            console.log(`  - 저장 경로: ${filePath}`);
            console.log('✅ 파일 저장 완료');
        } catch (writeError) {
            console.error('❌ 파일 저장 실패:', writeError.message);
            return res.status(500).json({
                success: false,
                message: '파일 저장 중 오류가 발생했습니다',
                error: writeError.message
            });
        }

        // 데이터베이스에 저장
        const sql = `
            INSERT INTO uploaded_media 
            (original_name, saved_name, file_path, file_size, mime_type, file_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        const params = [
            fileInfo.originalName,
            savedName,
            filePath,
            fileInfo.size,
            fileInfo.mimeType,
            fileType
        ];

        db.run(sql, params, function(err) {
            if (err) {
                console.error('❌ DB 저장 실패:', err.message);
                // 파일 삭제
                try {
                    fs.unlinkSync(filePath);
                } catch (unlinkError) {
                    console.error('파일 삭제 실패:', unlinkError.message);
                }
                return res.status(500).json({
                    success: false,
                    message: '데이터베이스 저장 중 오류가 발생했습니다',
                    error: err.message
                });
            }

            const fileTypeEmoji = fileType === 'image' ? '🖼️' : '🎬';
            console.log(`💾 DB 저장 완료 (ID: ${this.lastID}) ${fileTypeEmoji}`);
            console.log('========================================\n');

            res.status(200).json({
                success: true,
                message: `${fileType === 'image' ? '이미지' : '영상'}가 성공적으로 업로드되었습니다`,
                data: {
                    id: this.lastID,
                    originalName: fileInfo.originalName,
                    savedName: savedName,
                    size: fileInfo.size,
                    fileType: fileType,
                    mimeType: fileInfo.mimeType,
                    url: `http://${myHost}:${PORT}/uploads/${encodeURIComponent(savedName)}`
                }
            });
        });
    });

    bb.on('error', (err) => {
        console.error('❌ Busboy 에러:', err);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: '파일 처리 중 오류가 발생했습니다',
                error: err.message
            });
        }
    });

    req.pipe(bb);
});

// 업로드된 미디어 목록 조회 API
app.get('/api/upload/media', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const fileType = req.query.type; // 'image', 'video', 또는 undefined (전체)

    let sql = `
        SELECT id, original_name, saved_name, file_size, mime_type, file_type, created_at 
        FROM uploaded_media
    `;
    const params = [];

    if (fileType) {
        sql += ' WHERE file_type = ?';
        params.push(fileType);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('❌ 목록 조회 실패:', err.message);
            res.status(500).json({ 
                success: false, 
                error: err.message 
            });
        } else {
            const mediaWithUrl = rows.map(row => ({
                ...row,
                url: `http://${myHost}:${PORT}/uploads/${encodeURIComponent(row.saved_name)}`,
                sizeFormatted: formatFileSize(row.file_size)
            }));
            
            console.log(`\n📋 미디어 목록 조회: ${mediaWithUrl.length}개 항목`);
            
            res.json({ 
                success: true, 
                count: mediaWithUrl.length,
                data: mediaWithUrl 
            });
        }
    });
});

// 특정 미디어 삭제 API
app.delete('/api/upload/media/:id', (req, res) => {
    const id = req.params.id;
    
    // DB에서 파일 정보 조회
    db.get('SELECT * FROM uploaded_media WHERE id = ?', [id], (err, row) => {
        if (err) {
            return res.status(500).json({ 
                success: false, 
                error: err.message 
            });
        }
        
        if (!row) {
            return res.status(404).json({ 
                success: false, 
                message: '파일을 찾을 수 없습니다' 
            });
        }
        
        // 파일 삭제
        try {
            if (fs.existsSync(row.file_path)) {
                fs.unlinkSync(row.file_path);
                console.log(`🗑️ 파일 삭제: ${row.saved_name}`);
            }
        } catch (unlinkError) {
            console.error('파일 삭제 실패:', unlinkError.message);
        }
        
        // DB에서 삭제
        db.run('DELETE FROM uploaded_media WHERE id = ?', [id], (err) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    error: err.message 
                });
            }
            
            console.log(`💾 DB 삭제 완료 (ID: ${id})`);
            res.json({ 
                success: true, 
                message: '파일이 성공적으로 삭제되었습니다' 
            });
        });
    });
});

// 파일 크기 포맷팅 함수
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// 루트 경로
app.get('/', (req, res) => {
    res.json({
        message: '미디어 업로드 API 서버',
        version: '2.0',
        endpoints: {
            upload: 'POST /api/upload/media',
            list: 'GET /api/upload/media?limit=50&type=image|video',
            delete: 'DELETE /api/upload/media/:id',
            static: 'GET /uploads/:filename'
        },
        supportedFormats: {
            image: ['JPEG', 'PNG', 'GIF', 'WebP'],
            video: ['MP4', 'MOV', 'AVI', 'MKV', 'WebM']
        },
        maxFileSize: '100MB',
        status: 'running'
    });
});

// 404 에러 핸들링
app.use((req, res) => {
    console.log(`❌ 알 수 없는 경로 요청: ${req.method} ${req.url}`);
    res.status(404).json({
        success: false,
        message: '요청한 API를 찾을 수 없습니다',
        path: req.url
    });
});

// 에러 핸들링
app.use((err, req, res, next) => {
    console.error('❌ 서버 에러:', err);
    if (!res.headersSent) {
        res.status(500).json({
            success: false,
            message: err.message || '서버 에러가 발생했습니다'
        });
    }
});

// 서버 시작
app.listen(PORT, myHost, () => {
    console.log('\n╔═══════════════════════════════════════╗');
    console.log('║   🚀 미디어 업로드 API 서버 시작    ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log(`\n📍 주소: http://${myHost}:${PORT}`);
    console.log(`💾 DB 경로: ${dbPath}`);
    console.log(`📁 업로드 폴더: ${uploadDir}`);
    console.log(`🕐 시작 시간: ${new Date().toLocaleString('ko-KR')}`);
    console.log('\n📡 API 엔드포인트:');
    console.log(`  📸 미디어 업로드: POST http://${myHost}:${PORT}/api/upload/media`);
    console.log(`  📋 미디어 목록: GET http://${myHost}:${PORT}/api/upload/media?limit=50`);
    console.log(`  🗑️ 미디어 삭제: DELETE http://${myHost}:${PORT}/api/upload/media/:id`);
    console.log(`  📁 정적 파일: GET http://${myHost}:${PORT}/uploads/:filename`);
    console.log('\n✅ 서버가 요청을 기다리고 있습니다...\n');
});

// 프로세스 종료 시 DB 연결 닫기
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('❌ DB 연결 종료 실패:', err.message);
        } else {
            console.log('\n💾 데이터베이스 연결 종료');
        }
        process.exit(0);
    });
});
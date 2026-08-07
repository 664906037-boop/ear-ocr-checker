# EAR OCR Checker — Hybrid V5

เวอร์ชันนี้แก้ปัญหา "ฝั่งรูปถ่ายอ่านไม่ขึ้น" และ "OCR อ่านรหัสผิด" โดยเปลี่ยนจาก OCR pass เดียวเป็น Hybrid OCR

## สิ่งที่ทำ
- PDF text layer (ถ้ามี)
- OCR ไทย + อังกฤษ 4 pass ต่อหน้า
- OCR รหัส A-Z/0-9 แยกอีก 2 pass ต่อหน้า
- Contrast / threshold preprocessing
- CONTAINER ใช้รูปแบบ ISO-like AAAA1234567
- SEAL/BOOKING ใช้ label context + candidate scoring
- แสดง OCR candidates ใต้แต่ละช่อง เพื่อเลือกค่าที่ OCR เห็นได้ทันที
- ไม่บังคับให้ค่าทั้งสองเอกสารเหมือนกัน เพื่อไม่ซ่อนความผิดพลาดจริง

## อัปเดต GitHub
แตก ZIP และอัปโหลดไฟล์ทั้ง 5 ไฟล์ทับใน repository เดิม จากนั้น Commit changes:
- index.html
- app.js
- styles.css
- vercel.json
- README.md

Vercel จะ deploy อัตโนมัติ

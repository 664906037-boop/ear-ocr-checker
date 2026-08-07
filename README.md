# EAR OCR Checker — Label Anchored V4

เวอร์ชันนี้แก้ปัญหาที่ OCR อ่านเลขได้ แต่เลือกเลขผิดหัวข้อ

## หลักการใหม่

ระบบจะไม่เลือก Code/เลขจากทั้งเอกสารมาเดาว่าเป็น SEAL หรือ BOOKING อีกต่อไป

- CONTAINER NUMBER: อ่านค่าที่ติดกับหัวข้อ CONTAINER/หมายเลขตู้ และมี fallback เฉพาะรูปแบบ Container ที่เข้มงวด
- SEAL NO: รับค่าเฉพาะที่อยู่หลัง/ใต้หัวข้อ SEAL/เลขซีล
- BOOKING: รับค่าเฉพาะที่อยู่หลัง/ใต้หัวข้อ BOOKING/เลขบุ๊กกิ้ง/หมายเลขจอง
- ถ้าหาหัวข้อหรือค่าที่เกี่ยวข้องไม่พบ ระบบจะแสดง "ไม่พบข้อมูล" แทนการเอา Order No., Invoice No. หรือเลขอื่นมาใส่ผิดช่อง

## OCR

- ภาษาไทย + อังกฤษ
- PDF ที่มี text layer จะอ่าน text ก่อน
- PDF scan / JPG / PNG / WEBP ใช้ OCR
- OCR หลาย pass: ต้นฉบับ, Contrast, sparse text, ขาวดำ
- Container มีการแก้ OCR confusion O/0, I/1, S/5 ฯลฯ อย่างจำกัดเฉพาะรูปแบบ Container

## การอัปเดต

แตก ZIP แล้วอัปโหลดไฟล์ทั้ง 5 ไฟล์ทับของเดิมใน GitHub:
- index.html
- app.js
- styles.css
- vercel.json
- README.md

Commit แล้ว Vercel จะ deploy ให้เอง

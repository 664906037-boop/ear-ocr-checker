# EAR OCR Checker — Mapped V6

เวอร์ชันนี้กำหนด mapping ของหัวข้อระหว่างเอกสาร 2 แบบโดยตรง

## Mapping
File 1 (EAR) -> File 2 (Vehicle Control Form)

- CONTAINER NUMBER -> Container No.
- SEAL NO -> SEAL
- BOOKING -> Booking No.

ระบบจะไม่ต้องให้ชื่อหัวข้อเหมือนกัน แต่จะมองว่าแต่ละคู่คือข้อมูลชนิดเดียวกัน

## วิธีดึงค่า
- ค้นหาหัวข้อเฉพาะตามประเภทของ File 1 และ File 2
- อ่านค่าที่อยู่หลังหัวข้อเดียวกัน หรือไม่เกิน 2 บรรทัดถัดไป
- ถ้าเจอหัวข้ออื่นก่อน จะหยุด ไม่หยิบเลขข้ามช่อง
- SEAL / BOOKING จะไม่ใช้ global guessing
- CONTAINER มี fallback เฉพาะรูปแบบ AAAA1234567
- ก่อนเปรียบเทียบจะลบเครื่องหมายขีดและช่องว่าง เช่น TCKU-4852578 = TCKU4852578

## อัปเดต GitHub
แตก ZIP แล้วอัปโหลดไฟล์ 5 ไฟล์ทับ repository เดิม:
- index.html
- app.js
- styles.css
- vercel.json
- README.md

Commit changes แล้ว Vercel จะ deploy อัตโนมัติ

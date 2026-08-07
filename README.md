# EAR OCR Checker — Spatial V7

เวอร์ชันนี้เปลี่ยนวิธีอ่านจาก text parser เป็น spatial OCR

## คู่ข้อมูลที่ตรวจ
- File 1: CONTAINER NUMBER ↔ File 2: Container No.
- File 1: SEAL NO ↔ File 2: SEAL
- File 1: BOOKING ↔ File 2: Booking No.

## หลักการ
OCR จะคืนตำแหน่งของแต่ละคำ (bounding box)
ระบบหา label ก่อน แล้วอ่านเฉพาะ code ที่อยู่ทางขวาในแถวเดียวกัน
ถ้าไม่มี จะดูพื้นที่แคบ ๆ ใต้ label เท่านั้น

จึงไม่ควรหยิบ FAX, Order No., Invoice No. หรือเลขจากช่องอื่นมาเป็น BOOKING/SEAL

## ผลตรวจ
- ทั้ง 3 คู่ตรงกัน: ผ่าน
- มีคู่ใดไม่ตรง: ไม่ผ่าน และระบุชื่อหัวข้อที่ไม่ตรง
- อ่านไม่ครบ: แจ้งว่ามีข้อมูลอ่านไม่พบ

## วิธีอัปเดต GitHub
แตก ZIP แล้วอัปโหลด 5 ไฟล์นี้ทับ repository เดิม:
- index.html
- app.js
- styles.css
- vercel.json
- README.md

Commit changes แล้วรอ Vercel deploy อัตโนมัติ

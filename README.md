# EAR OCR Document Checker

Web App แบบ Static สำหรับเปรียบเทียบเอกสาร 2 ไฟล์ โดยรองรับ:

- PDF รวมถึง PDF สแกน
- JPG / JPEG
- PNG
- WEBP

ตรวจสอบ 3 หัวข้อ:

1. CONTAINER NUMBER
2. SEAL NO
3. BOOKING

ระบบใช้ PDF.js แปลงหน้า PDF เป็นภาพ และใช้ Tesseract.js ทำ OCR ใน Browser จึงไม่มีการอัปโหลดเอกสารไปเก็บใน Server ของโปรเจกต์

## ไฟล์ที่ต้องอยู่หน้าแรกของ GitHub Repository

- index.html
- app.js
- styles.css
- vercel.json
- README.md

ห้ามอัปโหลด ZIP ทั้งก้อน ต้องแตก ZIP ก่อนและอัปโหลดไฟล์ทั้ง 5 รายการด้านบน

## วิธีอัปโหลดขึ้น GitHub

1. สร้าง Repository ใหม่และปล่อยให้ว่าง
2. เข้า Repository แล้วเลือก **Add file → Upload files**
3. แตก ZIP ที่ได้รับ
4. เปิดโฟลเดอร์ที่แตกแล้ว เลือกไฟล์ทั้งหมดด้านใน
5. ลากไฟล์ทั้งหมดลง GitHub
6. กด **Commit changes**

## วิธี Deploy บน Vercel

1. เข้า Vercel ด้วยบัญชี GitHub
2. เลือก **Add New → Project**
3. เลือก Repository นี้ แล้วกด **Import**
4. Framework Preset เลือก **Other** หรือใช้ค่าที่ Vercel ตรวจพบ
5. Root Directory ใช้ `./`
6. ไม่ต้องใส่ Build Command
7. ไม่ต้องใส่ Output Directory
8. กด **Deploy**

## หมายเหตุ

- OCR ฟรีอาจใช้เวลานานใน PDF หลายหน้า
- ระบบตั้งค่าให้อ่าน PDF สูงสุด 10 หน้า เพื่อควบคุมเวลาและหน่วยความจำ
- รูปควรชัด ตรง ไม่มืด และตัวอักษรไม่เล็กเกินไป
- หาก OCR อ่านผิด สามารถแก้ค่าในตารางแล้วพิมพ์ผลได้

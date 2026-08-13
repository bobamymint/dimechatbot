import { complete } from "./llmComplete";

// A safe placeholder the UI/admin can recognize and edit before approving,
// same convention used inside app/api/chat/route.ts's system prompt: never
// invent a number/policy the model isn't sure of.
const UNVERIFIED_PLACEHOLDER = "[ต้องยืนยันข้อมูลนี้กับทีมผลิตภัณฑ์ก่อน]";

/**
 * Ask the model to draft a candidate knowledge-base answer for a question
 * that's been asked repeatedly but the bot currently has no knowledge for.
 *
 * IMPORTANT: this text is ONLY ever stored in knowledge_suggestions.draft_answer
 * as a proposal. It is never embedded or written to document_chunks here —
 * that only happens in app/api/admin/suggestions/[id]/approve/route.ts, and
 * only after a human admin has reviewed (and optionally edited) it.
 */
export async function draftAnswer(question: string): Promise<string> {
  const prompt = `คุณกำลังช่วยร่างคำตอบสำหรับเพิ่มเข้าฐานความรู้ของธนาคาร
คำถามนี้ลูกค้า/เจ้าหน้าที่ถามบ่อย แต่ระบบยังไม่มีคำตอบ:
"${question}"

ร่างคำตอบที่เป็นไปได้ โดยยึดหลักเดียวกับระบบตอบคำถามหลัก:
ห้ามเดาตัวเลข/นโยบายที่ไม่แน่ใจ ถ้าไม่มั่นใจให้เขียนว่า
"${UNVERIFIED_PLACEHOLDER}" แทนการเดา

ตอบเป็นคำตอบร่างเดียว ไม่ต้องมีคำนำหรือคำลงท้าย`;

  try {
    return await complete(prompt);
  } catch (err) {
    console.error("draftAnswer failed", err);
    return `${UNVERIFIED_PLACEHOLDER} (AI ร่างคำตอบไม่สำเร็จ — กรุณาเขียนคำตอบเองก่อนอนุมัติ)`;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { clinicalNote, targetLanguage = 'English' } = req.body || {};

  if (!clinicalNote || clinicalNote.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a clinical discharge note to translate.' });
  }

  // Accepts either GEMINI_API_KEY or GOOGLE_API_KEY in Vercel
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();

  if (!apiKey) {
    return res.status(500).json({
      error: 'API key not found on server. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in Vercel Environment Variables and Redeploy.'
    });
  }

  async function callGeminiModel(modelName, systemPrompt, userPrompt) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      const msg = errJson?.error?.message || `Google API HTTP ${response.status}`;
      const err = new Error(msg);
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(rawText.replace(/```json|```/g, '').trim());
  }

  async function callLLM(systemPrompt, userPrompt) {
    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        return await callGeminiModel(model, systemPrompt, userPrompt);
      } catch (err) {
        lastError = err;
        // Stop retrying immediately if the API key itself is invalid or blocked
        if (err.status === 400 || err.status === 403) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  try {
    // AGENT 1: CLINICAL TRANSLATOR & MEDICATION EXTRACTOR
    const agent1System = `You are Agent 1 (NHS ClearCare Patient Translator). Rewrite complex clinical discharge notes into warm, clear, accessible language at an 8th-grade reading level in ${targetLanguage}.
STRICT SAFETY RULES:
1. Never invent diagnoses, medications, dosages, or medical advice not present in the source text.
2. Convert Latin/clinical abbreviations (e.g., OD = once daily, BD/BID = twice daily, PRN = when needed, MI = heart attack) into plain everyday words.
3. Extract every prescribed medication mentioned into structured objects.
4. Return ONLY valid JSON with this exact schema:
{
  "patientSummary": "Plain-language explanation of what happened in hospital and recovery steps in ${targetLanguage}",
  "urgentWarnings": ["Clear red-flag symptoms requiring 999 or 111 action in ${targetLanguage}"],
  "followUpPlan": "Plain-language summary of GP or hospital follow-up appointments in ${targetLanguage}",
  "medications": [
    {
      "name": "Medication name and strength",
      "purpose": "Simple reason for taking it in ${targetLanguage}",
      "schedule": "e.g., 08:00 AM (Once daily with food)",
      "instructions": "Plain-language dosing instructions in ${targetLanguage}"
    }
  ]
}`;

    const translationResult = await callLLM(
      agent1System,
      `Original Clinical Discharge Note:\n"""\n${clinicalNote}\n"""`
    );

    // AGENT 2: CLINICAL SAFETY & HALLUCINATION AUDITOR
    const agent2System = `You are Agent 2 (NHS ClearCare Clinical Safety Auditor). Independently audit Agent 1's patient translation against the Doctor's Original Clinical Note to detect hallucinations, altered dosages, omitted warnings, or unsafe phrasing.
Return ONLY valid JSON with this exact schema:
{
  "overallStatus": "PASSED" or "FLAGGED",
  "safetyScore": "e.g., 8/8 Checks Passed",
  "auditorNote": "One-sentence summary of verification findings",
  "checks": [
    { "name": "Dosage & Frequency Match", "passed": true, "detail": "Short verification note" },
    { "name": "Zero Hallucinated Drugs", "passed": true, "detail": "Short verification note" },
    { "name": "Red-Flag Warnings Preserved", "passed": true, "detail": "Short verification note" },
    { "name": "8th-Grade Reading Accessibility", "passed": true, "detail": "Short verification note" },
    { "name": "Contraindications & Allergies Checked", "passed": true, "detail": "Short verification note" },
    { "name": "Target Language Fidelity (${targetLanguage})", "passed": true, "detail": "Short verification note" },
    { "name": "Demographic & Equity Neutrality", "passed": true, "detail": "Short verification note" },
    { "name": "Follow-Up Instructions Accurate", "passed": true, "detail": "Short verification note" }
  ]
}`;

    const auditResult = await callLLM(
      agent2System,
      `ORIGINAL CLINICAL NOTE:\n"""\n${clinicalNote}\n"""\n\nAGENT 1 TRANSLATED OUTPUT:\n${JSON.stringify(translationResult, null, 2)}`
    );

    return res.status(200).json({
      translation: translationResult,
      audit: auditResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Two-Agent Pipeline Error:', error);
    return res.status(500).json({
      error: `AI Pipeline Error: ${error.message}`
    });
  }
};
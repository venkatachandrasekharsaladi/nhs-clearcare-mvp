export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { clinicalNote, targetLanguage = 'English' } = req.body || {};

  if (!clinicalNote || clinicalNote.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a clinical discharge note to translate.' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !openaiKey) {
    return res.status(500).json({
      error: 'Server API key not configured. Add GEMINI_API_KEY or OPENAI_API_KEY in Vercel Environment Variables.'
    });
  }

  // Helper to call either Gemini or OpenAI and return parsed JSON
  async function callLLM(systemPrompt, userPrompt) {
    if (geminiKey) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
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
        const errText = await response.text();
        throw new Error(`Gemini API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } else {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API Error (${response.status}): ${errText}`);
      }

      const data = await response.json();
      const rawText = data.choices?.[0]?.message?.content || '{}';
      return JSON.parse(rawText.replace(/```json|```/g, '').trim());
    }
  }

  try {
    // =========================================================================
    // AGENT 1: CLINICAL TRANSLATOR & MEDICATION EXTRACTOR
    // =========================================================================
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

    // =========================================================================
    // AGENT 2: CLINICAL SAFETY & HALLUCINATION AUDITOR
    // =========================================================================
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
      error: 'AI pipeline encountered an error. Check your API key quota or try again.',
      details: error.message
    });
  }
}
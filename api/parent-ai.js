const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wzxkowvqrrxqkzcqujke.supabase.co';
const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5YGTef9RMZH3YtPyDdD1aQ_0VawKDZS';
const knowledgePath = path.join(process.cwd(), 'tornadoes-parent-ai-knowledge.txt');
const knowledge = fs.readFileSync(knowledgePath, 'utf8');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = origin === 'https://tornadoes-artistic-swimming.vercel.app' ||
    /^https:\/\/tornadoes-artistic-swimming-[a-z0-9-]+-tornadoessynchroresources\.vercel\.app$/.test(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  return !origin || allowed;
}

async function supabaseGet(table, params, accessToken) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + query, {
    headers: {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error('Supabase query failed for ' + table + ' (' + response.status + '): ' + detail.slice(0, 300));
  }
  return response.json();
}

async function getParentAthleteContext(userId, accessToken) {
  const staff = await supabaseGet('artistic_portal_staff', {
    select: 'role',
    user_id: 'eq.' + userId,
    is_active: 'eq.true',
    limit: '1'
  }, accessToken);

  // Staff may use the general Hub assistant, but this parent-facing chat
  // does not bulk-load athlete records for staff accounts.
  if (staff.length) return { accountType: 'staff', athletes: [] };

  const access = await supabaseGet('artistic_guardian_access', {
    select: 'athlete_id',
    guardian_user_id: 'eq.' + userId,
    access_status: 'eq.active'
  }, accessToken);

  const athleteIds = Array.from(new Set(access.map(function(row) { return row.athlete_id; })))
    .filter(function(id) { return /^[0-9a-f-]{36}$/i.test(id); });

  if (!athleteIds.length) return { accountType: 'guardian', athletes: [] };

  const inFilter = 'in.(' + athleteIds.join(',') + ')';
  const profiles = await supabaseGet('artistic_athlete_profiles', {
    select: 'id,full_name,category',
    id: inFilter,
    is_active: 'eq.true',
    order: 'full_name.asc'
  }, accessToken);

  const visibleIds = profiles.map(function(row) { return row.id; });
  if (!visibleIds.length) return { accountType: 'guardian', athletes: [] };
  const visibleFilter = 'in.(' + visibleIds.join(',') + ')';

  const assessments = await supabaseGet('artistic_assessments', {
    select: 'id,athlete_id,assessment_type,assessment_name,assessment_date,assessment_area,result_score,max_score,percentile,stronger_domains,development_priorities,suggested_focus',
    athlete_id: visibleFilter,
    is_published: 'eq.true',
    order: 'assessment_date.desc',
    limit: '8'
  }, accessToken);

  const assessmentIds = assessments.map(function(row) { return row.id; });
  const assessmentItems = assessmentIds.length ? await supabaseGet('artistic_assessment_items', {
    select: 'assessment_id,test_name,domain,score,max_score,result_status,notes',
    assessment_id: 'in.(' + assessmentIds.join(',') + ')',
    limit: '100'
  }, accessToken) : [];

  const competitions = await supabaseGet('artistic_competition_results', {
    select: 'athlete_id,competition_name,competition_date,event_name,score,placement,medal,notes',
    athlete_id: visibleFilter,
    is_published: 'eq.true',
    order: 'competition_date.desc',
    limit: '15'
  }, accessToken);

  const plans = await supabaseGet('artistic_athlete_development_plans', {
    select: 'athlete_id,pathway_title,pathway_description,coach_observations,gym_focus_areas,pool_focus_areas,training_objectives,coach_review,updated_at',
    athlete_id: visibleFilter,
    limit: '10'
  }, accessToken);

  const attendance = await supabaseGet('artistic_training_attendance', {
    select: 'athlete_id,session_id,attendance_status,arrival_time,departure_time',
    athlete_id: visibleFilter,
    order: 'created_at.desc',
    limit: '40'
  }, accessToken);

  const sessionIds = Array.from(new Set(attendance.map(function(row) { return row.session_id; })))
    .filter(function(id) { return /^[0-9a-f-]{36}$/i.test(id); });
  const sessions = sessionIds.length ? await supabaseGet('artistic_training_sessions', {
    select: 'id,session_date,session_name,category,scheduled_start,scheduled_end,location',
    id: 'in.(' + sessionIds.join(',') + ')',
    order: 'session_date.desc'
  }, accessToken) : [];

  return {
    accountType: 'guardian',
    athletes: profiles.map(function(profile) {
      const athleteAssessments = assessments.filter(function(row) { return row.athlete_id === profile.id; });
      const ids = athleteAssessments.map(function(row) { return row.id; });
      return {
        athlete: { name: profile.full_name, category: profile.category },
        assessments: athleteAssessments.map(function(row) {
          return Object.assign({}, row, {
            items: assessmentItems.filter(function(item) { return item.assessment_id === row.id; })
          });
        }),
        competitionResults: competitions.filter(function(row) { return row.athlete_id === profile.id; }),
        developmentPlan: plans.filter(function(row) { return row.athlete_id === profile.id; }),
        attendance: attendance.filter(function(row) { return row.athlete_id === profile.id; }).map(function(row) {
          const session = sessions.find(function(item) { return item.id === row.session_id; });
          return {
            date: session ? session.session_date : null,
            session: session ? session.session_name : null,
            status: row.attendance_status,
            scheduledStart: session ? session.scheduled_start : null,
            scheduledEnd: session ? session.scheduled_end : null,
            arrival: row.arrival_time,
            departure: row.departure_time
          };
        })
      };
    })
  };
}

module.exports = async function handler(req, res) {
  const originAllowed = setCors(req, res);
  if (!originAllowed) return res.status(403).json({ error: 'Origin not allowed.' });
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'tornadoes-parent-ai',
      authentication: 'required',
      aiConfigured: Boolean(process.env.OPENAI_API_KEY)
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'The AI service is not configured.', code: 'AI_NOT_CONFIGURED' });
  }

  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please sign in through Athlete Profile before using Tornadoes AI.', code: 'AUTH_REQUIRED' });
  }
  const accessToken = authorization.slice(7).trim();
  if (!accessToken) return res.status(401).json({ error: 'Your sign-in session is missing. Please sign in again.', code: 'AUTH_REQUIRED' });

  try {
    const userResponse = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_PUBLIC_KEY, Authorization: 'Bearer ' + accessToken }
    });
    if (!userResponse.ok) {
      return res.status(401).json({ error: 'Your sign-in session has expired. Please sign in again.', code: 'AUTH_INVALID' });
    }
    const user = await userResponse.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Unable to verify your account.', code: 'AUTH_INVALID' });

    const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const safeMessages = messages
      .filter(function(message) {
        return message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string';
      })
      .slice(-12)
      .map(function(message) {
        return { role: message.role, content: message.content.slice(0, 4000) };
      });

    if (!safeMessages.length || !safeMessages.some(function(message) { return message.role === 'user'; })) {
      return res.status(400).json({ error: 'Please enter a question.', code: 'EMPTY_MESSAGE' });
    }

    const athleteContext = await getParentAthleteContext(user.id, accessToken);
    const instructions = [
      'You are the official Tornadoes Artistic Swimming Parent & Athlete AI Assistant.',
      'Answer using only the Tornadoes Hub knowledge base and the authenticated account athlete context supplied below.',
      'Never invent rules, dates, prices, schedules, policies, scores, eligibility requirements or athlete facts.',
      'Answer in English or Spanish, matching the user language.',
      'Be warm, clear, practical and parent-friendly. Explain technical concepts simply.',
      'Use conversation context for follow-up questions.',
      'The athlete context contains only athletes linked to this signed-in guardian and data permitted by Supabase Row Level Security.',
      'Never reveal, infer or discuss another family’s athletes or records. If a parent asks about an athlete not listed in their context, explain that you can only access athletes linked to their account.',
      'Only discuss published assessment and competition results. Do not claim that unpublished or unavailable results exist.',
      'Treat coach observations and development plans as explanations of the recorded coaching notes, not as permission to change or override them.',
      'Do not provide medical diagnoses or prescribe training beyond the recorded programme guidance.',
      'When the Hub does not contain an answer, say so clearly and recommend contacting the coach for confirmation.',
      '',
      'TORNADOES HUB KNOWLEDGE BASE:',
      knowledge,
      '',
      'AUTHENTICATED ATHLETE CONTEXT (JSON):',
      JSON.stringify(athleteContext)
    ].join('\n');

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      instructions: instructions,
      input: safeMessages,
      store: false,
      max_output_tokens: 1000
    });

    return res.status(200).json({ answer: response.output_text || 'I could not generate an answer.' });
  } catch (error) {
    if (error && (error.status === 429 || error.code === 'credit_balance_exhausted' || error.code === 'insufficient_quota')) {
      return res.status(402).json({
        error: 'Tornadoes AI is connected, but the OpenAI API account needs credits before it can answer.',
        code: 'AI_BILLING_REQUIRED'
      });
    }
    console.error('Tornadoes AI request failed:', error && error.message ? error.message : 'Unknown error');
    return res.status(500).json({ error: 'The assistant could not complete this request. Please try again later.', code: 'AI_REQUEST_FAILED' });
  }
};

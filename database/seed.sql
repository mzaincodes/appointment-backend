-- =============================================================================
--  Bright Smile Dental Studio — Development Seed Data
-- =============================================================================
--  Apply AFTER schema.sql:
--      psql -U <user> -d dentist_booking -f database/seed.sql
--
--  Re-runnable: every statement is idempotent (ON CONFLICT / guarded inserts),
--  and the appointment block clears its own demo rows first.
--
--  ⚠️  DEVELOPMENT CREDENTIALS ONLY — these accounts and password hashes are
--      published in the repository and are meaningless outside local dev.
--      Never load this file into an environment that holds real patient data.
--
--      Admin    admin@brightsmiledental.com   Admin@123
--      Patient  zain@example.com              Patient@123
--      Patient  amelia.hart@example.com       Patient@123
--      Patient  daniel.osei@example.com       Patient@123
--      Patient  sofia.marino@example.com      Patient@123
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
--  Opening hours — Monday to Saturday 09:00-17:00, closed Sunday
-- -----------------------------------------------------------------------------
--  The availability engine reads these rows; it has no hard-coded schedule.
INSERT INTO clinic_hours (day_of_week, is_open, opens_at, closes_at) VALUES
    (0, FALSE, NULL,    NULL),      -- Sunday    — closed
    (1, TRUE,  '09:00', '17:00'),   -- Monday
    (2, TRUE,  '09:00', '17:00'),   -- Tuesday
    (3, TRUE,  '09:00', '17:00'),   -- Wednesday
    (4, TRUE,  '09:00', '17:00'),   -- Thursday
    (5, TRUE,  '09:00', '17:00'),   -- Friday
    (6, TRUE,  '09:00', '17:00')    -- Saturday
ON CONFLICT (day_of_week) DO UPDATE
    SET is_open   = EXCLUDED.is_open,
        opens_at  = EXCLUDED.opens_at,
        closes_at = EXCLUDED.closes_at;

-- -----------------------------------------------------------------------------
--  Users
-- -----------------------------------------------------------------------------
--  Hashes are real bcrypt digests (cost 10) of the passwords documented above.
INSERT INTO users (name, email, password_hash, phone, role) VALUES
    ('Clinic Administrator', 'admin@brightsmiledental.com',
     '$2a$10$nNTD7Fp3ZW/ZStIOJk4tQ.GcEs4Trn/35oJk4mMwrc44nwKyU4TXK', '+1 415 555 0142', 'ADMIN'),

    ('Muhammad Zain', 'zain@example.com',
     '$2a$10$pVDisNOWvOFc/Cf070oTIOge6KMDOmuAi90QbvdtESqQWqk3pHDfy', '+1 415 555 0188', 'USER'),

    ('Amelia Hart', 'amelia.hart@example.com',
     '$2a$10$pVDisNOWvOFc/Cf070oTIOge6KMDOmuAi90QbvdtESqQWqk3pHDfy', '+1 415 555 0173', 'USER'),

    ('Daniel Osei', 'daniel.osei@example.com',
     '$2a$10$pVDisNOWvOFc/Cf070oTIOge6KMDOmuAi90QbvdtESqQWqk3pHDfy', '+1 415 555 0166', 'USER'),

    ('Sofia Marino', 'sofia.marino@example.com',
     '$2a$10$pVDisNOWvOFc/Cf070oTIOge6KMDOmuAi90QbvdtESqQWqk3pHDfy', '+1 415 555 0159', 'USER')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
--  Services
-- -----------------------------------------------------------------------------
--  Every first visit is booked as one 30-minute slot. Longer treatments start
--  with a 30-minute consultation at which the full plan is scheduled — this is
--  the assumption that lets the whole system use a uniform slot grid.
INSERT INTO services (slug, name, description, duration_min, price_from, icon, display_order) VALUES
    ('checkup', 'Dental Check-up & Consultation',
     'A complete oral health examination including digital X-rays where needed, gum assessment and a personalised treatment plan.',
     30, 60.00, 'stethoscope', 1),

    ('cleaning', 'Professional Cleaning',
     'Scaling and polishing to remove plaque and tartar, followed by a fluoride finish. Recommended every six months.',
     30, 90.00, 'sparkles', 2),

    ('filling', 'Tooth-Coloured Fillings',
     'Durable composite fillings colour-matched to your natural enamel, restoring decayed or chipped teeth invisibly.',
     30, 140.00, 'shield', 3),

    ('whitening', 'Teeth Whitening',
     'Professional in-chair whitening that lifts staining from coffee, tea and tobacco, with take-home trays to maintain results.',
     30, 250.00, 'sun', 4),

    ('root-canal', 'Root Canal Treatment',
     'Endodontic therapy that relieves pain and saves an infected tooth, performed under local anaesthetic.',
     30, 400.00, 'activity', 5),

    ('crown', 'Crowns & Bridges',
     'Custom ceramic crowns and bridges that restore strength and appearance to damaged or missing teeth.',
     30, 650.00, 'crown', 6),

    ('implant', 'Dental Implants',
     'Titanium implants with ceramic crowns — a permanent replacement for missing teeth. Begins with a consultation and 3D scan.',
     30, 1800.00, 'anchor', 7),

    ('orthodontics', 'Orthodontics & Clear Aligners',
     'Discreet clear aligners and modern braces to straighten teeth, planned with a digital smile preview.',
     30, 2200.00, 'align-center', 8),

    ('paediatric', 'Children''s Dentistry',
     'Gentle, friendly care for younger patients — check-ups, fluoride varnish, fissure sealants and prevention advice.',
     30, 55.00, 'baby', 9),

    ('emergency', 'Emergency Dental Care',
     'Same-day relief for severe toothache, swelling, broken teeth or lost fillings. Call us and we will prioritise you.',
     30, 95.00, 'zap', 10)
ON CONFLICT (slug) DO UPDATE
    SET name          = EXCLUDED.name,
        description   = EXCLUDED.description,
        price_from    = EXCLUDED.price_from,
        icon          = EXCLUDED.icon,
        display_order = EXCLUDED.display_order;

-- -----------------------------------------------------------------------------
--  Clinic knowledge base  (the RAG corpus)
-- -----------------------------------------------------------------------------
--  Each row is one retrievable document, deliberately kept short and single
--  topic so a retrieved chunk is small enough to drop straight into the prompt.
--  `keywords` carries colloquial phrasings that do not appear in the prose --
--  this is what makes retrieval robust for questions like "how much does it
--  cost" against a document titled "Payment & Insurance".
--
--  `priority` breaks ties when several documents score similarly.
DELETE FROM clinic_knowledge;
INSERT INTO clinic_knowledge (category, title, content, keywords, priority) VALUES

('general', 'About Bright Smile Dental Studio',
 'Bright Smile Dental Studio is a modern family and cosmetic dental practice in San Francisco. We have cared for the Marina District community since 2009 and now look after more than 6,000 registered patients. The practice combines preventive family dentistry with advanced cosmetic and restorative treatment in a calm, spa-like setting. Every surgery is equipped with digital X-ray, intra-oral cameras and same-day CEREC ceramics.',
 'about who are you clinic name practice introduction tell me about your clinic background history', 10),

('hours', 'Opening Hours',
 'The clinic is open Monday to Saturday from 9:00 AM to 5:00 PM. We are CLOSED on Sundays. The last appointment of each day starts at 4:30 PM, because every appointment is 30 minutes long and must finish by 5:00 PM. Appointments are available on the half hour throughout the day: 9:00, 9:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30, 1:00, 1:30, 2:00, 2:30, 3:00, 3:30, 4:00 and 4:30.',
 'hours open opening times timing when open what time close closing sunday saturday weekend late early schedule availability', 10),

('hours', 'Sunday and Holiday Closures',
 'We do not open on Sundays. If you need urgent help on a Sunday, call our emergency line on +1 (415) 555-0142 and the on-call dentist will advise you. The clinic also closes on public holidays; these are announced on the website and by SMS at least two weeks in advance.',
 'sunday closed holiday public holiday emergency weekend bank holiday', 8),

('appointments', 'Appointment Length and Slots',
 'Every appointment is a 30-minute slot. The booking calendar shows the exact half-hour times still free on the day you choose. Longer treatments such as implants, root canal therapy or orthodontics start with a 30-minute consultation, and the dentist then schedules the additional time you need directly with reception.',
 'how long appointment duration slot length 30 minutes half hour time per appointment', 9),

('appointments', 'How to Book an Appointment',
 'There are three ways to book. First, use the Book Appointment page on this website: pick a date, choose from the available 30-minute slots, enter your details and confirm. Second, ask me here in the chat and I will check live availability and book it for you. Third, call reception on +1 (415) 555-0142 during opening hours. You do not need an account to book, but signing in fills your details in automatically and lets you see all your appointments in one place.',
 'how to book booking make appointment schedule reserve arrange set up register book me', 10),

('appointments', 'Information Needed to Book',
 'To confirm a booking we need four things: your full name, an email address, a contact phone number, and the reason for your visit (for example "check-up", "toothache" or "teeth cleaning"). Notes are optional but useful — tell us about anxiety, medication, allergies or accessibility needs and we will prepare for them.',
 'what information required details need to provide name email phone reason data needed', 8),

('appointments', 'Cancelling or Rescheduling',
 'You can cancel or reschedule free of charge up to 24 hours before your appointment. Sign in and open My Appointments to cancel, or ask me in the chat and I will do it for you. Cancellations inside 24 hours, and appointments missed without notice, may incur a $25 late-cancellation fee. Rescheduling is simply a cancellation plus a new booking, and the freed slot returns to the calendar immediately.',
 'cancel cancellation reschedule change move appointment refund fee late no show missed', 9),

('appointments', 'Arriving for Your Appointment',
 'Please arrive five to ten minutes early so we can complete your medical history. Bring a list of any medication you take and, if you are insured, your insurance details. If you are more than 10 minutes late we may need to shorten or rebook your appointment so that following patients are not delayed.',
 'arrive early late what to bring first visit new patient checkin check in', 5),

('dentists', 'Dr. Sarah Chen — Lead Dentist & Clinical Director',
 'Dr. Sarah Chen, DDS, founded Bright Smile Dental Studio and leads the clinical team. She qualified from the University of California, San Francisco and has 16 years of experience, specialising in cosmetic dentistry and full-mouth restorative work. She is a member of the American Academy of Cosmetic Dentistry and teaches on the UCSF restorative programme.',
 'dentist doctor who is the dentist sarah chen lead director cosmetic qualified experience staff team', 9),

('dentists', 'Dr. Omar Haddad — Orthodontist',
 'Dr. Omar Haddad, DMD, leads our orthodontic service. He trained at Boston University and has 12 years of experience with clear aligners and fixed braces for both teenagers and adults. He plans every case with a digital smile preview so you can see the projected result before treatment begins.',
 'orthodontist braces aligners invisalign omar haddad straighten teeth crooked', 7),

('dentists', 'Dr. Priya Raman — Paediatric & Preventive Dentistry',
 'Dr. Priya Raman, BDS, MSc, looks after our younger patients and our preventive care programme. She has 10 years of experience in paediatric dentistry and is known for a calm, unhurried approach with anxious children and adults alike.',
 'children kids paediatric pediatric priya raman child dentist nervous anxious', 7),

('dentists', 'Dr. James Whitfield — Oral Surgery & Implantology',
 'Dr. James Whitfield, DDS, is our oral surgeon and implantologist. With 18 years of experience he handles surgical extractions, bone grafting and all stages of dental implant placement, working with 3D CBCT planning for precision.',
 'surgeon oral surgery implants extraction wisdom teeth james whitfield', 7),

('services', 'Treatments We Provide',
 'We provide: dental check-ups and consultations; professional cleaning (scaling and polishing); tooth-coloured composite fillings; professional teeth whitening; root canal treatment; crowns and bridges; dental implants; orthodontics including clear aligners; children''s dentistry; and emergency dental care. Every treatment starts with a 30-minute appointment.',
 'services treatments what do you offer procedures options provide list of services', 10),

('services', 'Cosmetic Dentistry',
 'Our cosmetic services include professional in-chair teeth whitening from $250, porcelain veneers, composite bonding, and smile makeovers that combine several treatments. Dr. Sarah Chen leads all cosmetic cases and will show you a digital preview of the planned result at your consultation.',
 'cosmetic whitening veneers bonding smile makeover appearance white teeth', 6),

('services', 'Emergency Dental Care',
 'We keep emergency slots free every day for severe toothache, facial swelling, knocked-out or broken teeth, and lost fillings or crowns. Call +1 (415) 555-0142 as early in the day as possible and we will see you the same day wherever we can. Outside opening hours the same number reaches our on-call dentist.',
 'emergency urgent pain toothache same day broken tooth swelling accident knocked out', 8),

('pricing', 'Payment, Pricing & Insurance',
 'Indicative starting prices: check-up from $60, professional cleaning from $90, composite filling from $140, teeth whitening from $250, root canal from $400, crown from $650, implant from $1,800, clear aligners from $2,200, children''s check-up from $55, emergency visit from $95. The exact fee depends on your clinical needs and is always confirmed in writing before treatment starts. We accept cash, all major cards and Apple Pay, work with most major insurers including Delta Dental, Cigna and MetLife, and offer 0% interest payment plans over 6 or 12 months on treatment above $500.',
 'price cost how much fee payment insurance pay expensive cheap money charge billing finance plan afford', 9),

('location', 'Location, Parking & Contact',
 'Bright Smile Dental Studio, 218 Marina Boulevard, Suite 300, San Francisco, CA 94123. Phone +1 (415) 555-0142, email hello@brightsmiledental.com. We are a three-minute walk from the Marina Green stop; the 30 and 43 bus routes stop directly outside. Two hours of free patient parking are available in the building garage — bring your ticket to reception for validation. The practice is fully step-free with lift access to the third floor.',
 'where address location find you directions parking transport bus contact phone number email map accessible wheelchair', 9),

('policies', 'New Patients',
 'We are accepting new patients and there is no registration fee. Your first visit is a 30-minute check-up and consultation from $60, which covers a full examination, any necessary X-rays and a written treatment plan. If you have records or X-rays from a previous dentist, ask them to email hello@brightsmiledental.com before your visit.',
 'new patient register registration join accepting sign up first visit transfer records', 7),

('policies', 'Nervous and Anxious Patients',
 'Dental anxiety is common and we plan for it. Tell us when you book — add it to the notes on your appointment — and we will book extra time, explain each step before it happens and agree a stop signal with you. Dr. Priya Raman looks after most of our anxious patients. Oral sedation is available for longer treatments if you would like it.',
 'nervous anxious scared afraid phobia sedation fear worried panic', 6),

('policies', 'Children and Family Care',
 'We welcome children from their first tooth onwards. Under-5s are seen free of charge alongside a parent''s appointment, and children''s check-ups start at $55. Dr. Priya Raman leads our paediatric care and takes time to make early visits positive rather than clinical. Fluoride varnish and fissure sealants are offered as routine prevention.',
 'children kids family baby toddler child free under 5 school age', 6),

('policies', 'Data & Privacy',
 'Your clinical records and contact details are stored securely and used only to provide your dental care and to contact you about appointments. We do not sell data or share it for marketing. You can ask for a copy of your records, or ask us to correct them, by emailing hello@brightsmiledental.com.',
 'privacy data gdpr records confidential security personal information', 4);

-- -----------------------------------------------------------------------------
--  Sample appointments
-- -----------------------------------------------------------------------------
--  Dates are relative to CURRENT_DATE so the seed always produces a sensible
--  mix of past and future bookings no matter when it is loaded.
--
--  Any offset that lands on a Sunday is nudged forward by a day, so no sample
--  row can ever fall on a closed day and contradict the availability rules.
--
--  NOTE ON CASTS: every NULL below carries an explicit type. In a multi-branch
--  UNION, PostgreSQL resolves column types pairwise from the top, so a run of
--  untyped NULLs collapses to `text` before it ever meets the timestamptz
--  branch further down — and the whole statement then fails to parse.
DELETE FROM appointments WHERE patient_email LIKE '%@example.com'
                            OR patient_email = 'walkin.guest@example.org';

WITH
-- Resolve each offset to a day the clinic is open.
offsets(label, raw_date) AS (
    VALUES
        ('past_1',   CURRENT_DATE - 9),
        ('past_2',   CURRENT_DATE - 6),
        ('past_3',   CURRENT_DATE - 3),
        ('past_4',   CURRENT_DATE - 2),
        ('today',    CURRENT_DATE),
        ('future_1', CURRENT_DATE + 1),
        ('future_2', CURRENT_DATE + 2),
        ('future_3', CURRENT_DATE + 3),
        ('future_4', CURRENT_DATE + 5),
        ('future_5', CURRENT_DATE + 8)
),
resolved AS (
    SELECT label,
           -- Shift Sundays (dow 0) forward by one day.
           CASE WHEN EXTRACT(DOW FROM raw_date) = 0 THEN raw_date + 1 ELSE raw_date END AS d
    FROM offsets
),
u AS (
    SELECT
        (SELECT id FROM users WHERE email = 'zain@example.com')          AS zain,
        (SELECT id FROM users WHERE email = 'amelia.hart@example.com')   AS amelia,
        (SELECT id FROM users WHERE email = 'daniel.osei@example.com')   AS daniel,
        (SELECT id FROM users WHERE email = 'sofia.marino@example.com')  AS sofia
),
s AS (
    SELECT
        (SELECT id FROM services WHERE slug = 'checkup')      AS checkup,
        (SELECT id FROM services WHERE slug = 'cleaning')     AS cleaning,
        (SELECT id FROM services WHERE slug = 'whitening')    AS whitening,
        (SELECT id FROM services WHERE slug = 'filling')      AS filling,
        (SELECT id FROM services WHERE slug = 'emergency')    AS emergency,
        (SELECT id FROM services WHERE slug = 'orthodontics') AS ortho
)
INSERT INTO appointments (
    user_id, patient_name, patient_email, patient_phone,
    appointment_date, start_time, end_time,
    service_id, reason, notes, status, source,
    completed_at, cancelled_at
)
SELECT * FROM (
    -- ---- Completed history -------------------------------------------------
    SELECT u.zain, 'Muhammad Zain', 'zain@example.com', '+1 415 555 0188',
           (SELECT d FROM resolved WHERE label = 'past_1'), TIME '10:00', TIME '10:30',
           s.checkup, 'Routine check-up', 'No issues found. Recall in 6 months.',
           'COMPLETED'::appointment_status, 'WEB', now() - INTERVAL '9 days', NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT u.amelia, 'Amelia Hart', 'amelia.hart@example.com', '+1 415 555 0173',
           (SELECT d FROM resolved WHERE label = 'past_2'), TIME '14:00', TIME '14:30',
           s.cleaning, 'Scale and polish', 'Mild gingivitis; advised interdental brushes.',
           'COMPLETED'::appointment_status, 'WEB', now() - INTERVAL '6 days', NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT u.daniel, 'Daniel Osei', 'daniel.osei@example.com', '+1 415 555 0166',
           (SELECT d FROM resolved WHERE label = 'past_3'), TIME '11:30', TIME '12:00',
           s.filling, 'Filling on upper right molar', 'Composite placed, patient comfortable.',
           'COMPLETED'::appointment_status, 'CHATBOT', now() - INTERVAL '3 days', NULL::timestamptz
    FROM u, s
    UNION ALL
    -- ---- Cancelled ---------------------------------------------------------
    SELECT u.sofia, 'Sofia Marino', 'sofia.marino@example.com', '+1 415 555 0159',
           (SELECT d FROM resolved WHERE label = 'past_4'), TIME '15:30', TIME '16:00',
           s.whitening, 'Teeth whitening consultation', 'Patient rescheduled — travelling.',
           'CANCELLED'::appointment_status, 'WEB', NULL::timestamptz, now() - INTERVAL '4 days'
    FROM u, s
    UNION ALL
    -- ---- Today -------------------------------------------------------------
    SELECT u.amelia, 'Amelia Hart', 'amelia.hart@example.com', '+1 415 555 0173',
           (SELECT d FROM resolved WHERE label = 'today'), TIME '09:30', TIME '10:00',
           s.checkup, 'Six-month check-up', NULL::text,
           'BOOKED'::appointment_status, 'WEB', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT NULL::uuid, 'Walk-in Guest', 'walkin.guest@example.org', '+1 415 555 0117',
           (SELECT d FROM resolved WHERE label = 'today'), TIME '13:00', TIME '13:30',
           s.emergency, 'Severe toothache since last night', 'Booked without an account at reception.',
           'BOOKED'::appointment_status, 'ADMIN', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT u.daniel, 'Daniel Osei', 'daniel.osei@example.com', '+1 415 555 0166',
           (SELECT d FROM resolved WHERE label = 'today'), TIME '16:00', TIME '16:30',
           s.cleaning, 'Hygienist appointment', NULL::text,
           'BOOKED'::appointment_status, 'CHATBOT', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    -- ---- Upcoming ----------------------------------------------------------
    SELECT u.zain, 'Muhammad Zain', 'zain@example.com', '+1 415 555 0188',
           (SELECT d FROM resolved WHERE label = 'future_1'), TIME '14:30', TIME '15:00',
           s.cleaning, 'Professional cleaning', 'Prefers an afternoon appointment.',
           'BOOKED'::appointment_status, 'WEB', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT u.sofia, 'Sofia Marino', 'sofia.marino@example.com', '+1 415 555 0159',
           (SELECT d FROM resolved WHERE label = 'future_2'), TIME '10:30', TIME '11:00',
           s.whitening, 'Teeth whitening', 'Rebooked after cancellation.',
           'BOOKED'::appointment_status, 'CHATBOT', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT NULL::uuid, 'Grace Nakamura', 'grace.nakamura@example.com', '+1 415 555 0121',
           (SELECT d FROM resolved WHERE label = 'future_2'), TIME '11:00', TIME '11:30',
           s.checkup, 'New patient consultation', 'Guest booking — no account.',
           'BOOKED'::appointment_status, 'WEB', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT u.amelia, 'Amelia Hart', 'amelia.hart@example.com', '+1 415 555 0173',
           (SELECT d FROM resolved WHERE label = 'future_3'), TIME '09:00', TIME '09:30',
           s.ortho, 'Clear aligner review', NULL::text,
           'BOOKED'::appointment_status, 'WEB', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT u.daniel, 'Daniel Osei', 'daniel.osei@example.com', '+1 415 555 0166',
           (SELECT d FROM resolved WHERE label = 'future_4'), TIME '15:00', TIME '15:30',
           s.checkup, 'Follow-up after filling', NULL::text,
           'BOOKED'::appointment_status, 'WEB', NULL::timestamptz, NULL::timestamptz
    FROM u, s
    UNION ALL
    SELECT NULL::uuid, 'Thomas Reed', 'thomas.reed@example.com', '+1 415 555 0198',
           (SELECT d FROM resolved WHERE label = 'future_5'), TIME '12:00', TIME '12:30',
           s.emergency, 'Chipped front tooth', NULL::text,
           'BOOKED'::appointment_status, 'CHATBOT', NULL::timestamptz, NULL::timestamptz
    FROM u, s
) AS rows_to_insert
-- Defensive: if the seed is re-run on a day where a slot is already occupied,
-- skip that row rather than aborting the whole transaction.
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
--  Sample chat session and transcript
-- -----------------------------------------------------------------------------
--  Demonstrates the multi-turn shape: an assistant turn that offered slots
--  carries the slot list in `payload`, so reloading the conversation re-renders
--  the selectable chips exactly as they first appeared.
DELETE FROM chat_sessions WHERE title IN ('Booking a cleaning', 'Opening hours enquiry');

WITH new_session AS (
    INSERT INTO chat_sessions (user_id, title, booking_context, metadata, last_message_at)
    SELECT id,
           'Booking a cleaning',
           jsonb_build_object('stage', 'completed', 'service', 'cleaning'),
           jsonb_build_object('channel', 'web-widget', 'seeded', true),
           now() - INTERVAL '2 hours'
    FROM users WHERE email = 'zain@example.com'
    RETURNING id
)
INSERT INTO chat_messages (session_id, role, content, payload, created_at)
SELECT new_session.id, msg.role::chat_role, msg.content, msg.payload, now() - msg.ago
FROM new_session,
     (VALUES
        ('user',      'Hi', NULL::jsonb, INTERVAL '2 hours 5 minutes'),
        ('assistant', 'Hello! 👋 Welcome to Bright Smile Dental Studio. I can help you book an appointment, check available times, or answer questions about our clinic and services. How can I help you today?', NULL, INTERVAL '2 hours 4 minutes'),
        ('user',      'I need a cleaning appointment this week', NULL, INTERVAL '2 hours 3 minutes'),
        ('assistant', 'Of course. Which day works best for you? We are open Monday to Saturday, 9:00 AM to 5:00 PM.', NULL, INTERVAL '2 hours 2 minutes'),
        ('user',      'Tomorrow afternoon if possible', NULL, INTERVAL '2 hours 1 minute'),
        ('assistant', 'Here are the afternoon slots still free tomorrow. Which one suits you?',
         '{"type":"slots","date":"tomorrow","slots":["13:00","13:30","14:30","15:30","16:00"]}'::jsonb,
         INTERVAL '2 hours'),
        ('user',      '2:30 PM please', NULL, INTERVAL '1 hour 59 minutes'),
        ('assistant', 'Your appointment is confirmed for tomorrow at 2:30 PM for a professional cleaning. You will receive a confirmation email shortly. Please arrive five minutes early. Is there anything else I can help with?',
         '{"type":"booking_confirmed","time":"14:30","service":"cleaning"}'::jsonb,
         INTERVAL '1 hour 58 minutes')
     ) AS msg(role, content, payload, ago);

-- A second, anonymous session — the case where a visitor chats before signing up.
WITH anon_session AS (
    INSERT INTO chat_sessions (user_id, title, guest_label, metadata, last_message_at)
    VALUES (NULL, 'Opening hours enquiry', 'Guest visitor',
            jsonb_build_object('channel', 'web-widget', 'seeded', true),
            now() - INTERVAL '1 day')
    RETURNING id
)
INSERT INTO chat_messages (session_id, role, content, created_at)
SELECT anon_session.id, msg.role::chat_role, msg.content, now() - msg.ago
FROM anon_session,
     (VALUES
        ('user',      'are you open on sunday?', INTERVAL '1 day 2 minutes'),
        ('assistant', 'We are closed on Sundays. The clinic is open Monday to Saturday from 9:00 AM to 5:00 PM, with the last appointment starting at 4:30 PM. If you have a dental emergency on a Sunday, call +1 (415) 555-0142 and our on-call dentist will advise you.', INTERVAL '1 day 1 minute')
     ) AS msg(role, content, ago);

-- -----------------------------------------------------------------------------
--  Sample AI interaction logs
-- -----------------------------------------------------------------------------
INSERT INTO ai_interactions (
    session_id, user_id, user_message, ai_response, provider, model,
    intent, tools_used, retrieved_docs, latency_ms, was_fallback
)
SELECT cs.id, cs.user_id,
       'Tomorrow afternoon if possible',
       'Here are the afternoon slots still free tomorrow. Which one suits you?',
       'mistral', 'mistral-small-latest',
       'appointment_booking',
       ARRAY['check_available_slots'],
       ARRAY['Appointment Length and Slots'],
       842, FALSE
FROM chat_sessions cs WHERE cs.title = 'Booking a cleaning';

INSERT INTO ai_interactions (
    session_id, user_id, user_message, ai_response, provider, model,
    intent, tools_used, retrieved_docs, latency_ms, was_fallback
)
SELECT cs.id, NULL,
       'are you open on sunday?',
       'We are closed on Sundays. The clinic is open Monday to Saturday from 9:00 AM to 5:00 PM…',
       'mistral', 'mistral-small-latest',
       'clinic_information',
       ARRAY['get_clinic_information'],
       ARRAY['Sunday and Holiday Closures', 'Opening Hours'],
       613, FALSE
FROM chat_sessions cs WHERE cs.title = 'Opening hours enquiry';

COMMIT;

-- -----------------------------------------------------------------------------
--  Summary
-- -----------------------------------------------------------------------------
SELECT 'users'            AS table_name, count(*) AS rows FROM users
UNION ALL SELECT 'services',         count(*) FROM services
UNION ALL SELECT 'clinic_hours',     count(*) FROM clinic_hours
UNION ALL SELECT 'clinic_knowledge', count(*) FROM clinic_knowledge
UNION ALL SELECT 'appointments',     count(*) FROM appointments
UNION ALL SELECT 'chat_sessions',    count(*) FROM chat_sessions
UNION ALL SELECT 'chat_messages',    count(*) FROM chat_messages
UNION ALL SELECT 'ai_interactions',  count(*) FROM ai_interactions
ORDER BY table_name;

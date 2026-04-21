const { createClient } = require('@supabase/supabase-js');

// Simple in-memory rate limiting (resets on function restart)
const rateLimitMap = new Map();
const RATE_LIMIT_REQUESTS = 20;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip;
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_REQUESTS - 1 };
  }
  
  const limit = rateLimitMap.get(key);
  
  // Reset if window has passed
  if (now > limit.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_REQUESTS - 1 };
  }
  
  // Check if over limit
  if (limit.count >= RATE_LIMIT_REQUESTS) {
    return { allowed: false, remaining: 0, resetTime: limit.resetTime };
  }
  
  // Increment count
  limit.count++;
  return { allowed: true, remaining: RATE_LIMIT_REQUESTS - limit.count };
}

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Rate limiting
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  const rateCheck = checkRateLimit(ip);
  
  if (!rateCheck.allowed) {
    const resetDate = new Date(rateCheck.resetTime);
    return {
      statusCode: 429,
      headers: {
        'Retry-After': Math.ceil((rateCheck.resetTime - Date.now()) / 1000).toString()
      },
      body: JSON.stringify({ 
        error: 'Rate limit exceeded. Try again later.',
        resetTime: resetDate.toISOString()
      })
    };
  }

  try {
    // Parse form data
    const { email, name } = JSON.parse(event.body);
    
    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email is required' })
      };
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Check if email already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('public_users')
      .select('email')
      .eq('email', email.toLowerCase())
      .single();

    // If email doesn't exist, add it to Supabase and Circle
    if (!existingUser) {
      // Add to Supabase
      const { error: insertError } = await supabase
        .from('public_users')
        .insert([
          { 
            email: email.toLowerCase(),
            name: name || null
          }
        ]);

      if (insertError) {
        console.error('Supabase insert error:', insertError);
      }

      // Add to Circle using the correct Admin v2 API endpoint
      try {
        const circleResponse = await fetch('https://app.circle.so/api/admin/v2/community_members', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${process.env.CIRCLE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email.toLowerCase(),
            name: name || '',
            skip_invitation: true
          })
        });

        console.log('Circle API status:', circleResponse.status);
        
        if (circleResponse.ok) {
          const circleData = await circleResponse.json();
          console.log('Circle API success:', circleData);
        } else {
          const errorText = await circleResponse.text();
          console.log('Circle API error:', errorText);
        }
      } catch (circleError) {
        console.error('Circle API call failed:', circleError);
        // Don't fail the whole function if Circle fails - Supabase capture still worked
      }
    }

    // Always redirect to the public Ask the Archive (whether new or existing email)
    return {
      statusCode: 302,
      headers: {
        'Location': '/ask-archive-public.html'
      }
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

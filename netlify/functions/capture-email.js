const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
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
      'https://ubcrrrapedaxkguxniwv.supabase.co',
      'eyJ1c2VySWQiOiJiNDBmOTQ2ZC0yM2QyLTRhZTktOTY0NS1kZDk0YzU3NzgzNTQiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzEzNDkwODYxLCJleHAiOjIwMjkwNjY4NjF9.q49Eu6A3W8vBhvYl2M0m6QVIaYZLZOLKQ8c6n-zJ5l4'
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

      // Add to Circle via Admin API
      try {
        const circleResponse = await fetch('https://app.circle.so/api/v1/community_members', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer sBobzqKomMkNGqoPKcvmrV5wvzDRL9xa`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email.toLowerCase(),
            first_name: name || '',
            skip_invitation: false,
            send_email_confirmation: true
          })
        });

        if (!circleResponse.ok) {
          console.error('Circle API error:', await circleResponse.text());
        }
      } catch (circleError) {
        console.error('Circle API request failed:', circleError);
      }
    }

    // Always redirect to the public Ask the Archive (whether new or existing email)
    return {
      statusCode: 302,
      headers: {
        'Location': 'https://thinkbeyondpractice.com/ask-archive-public'
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

#!/bin/bash

echo "🚀 Setting up secrets for Supabase + Bolt deployment..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Supabase CLI
if ! command -v supabase &> /dev/null; then
    echo "⚠️ Supabase CLI not installed. Installing..."
    npm install -g supabase
fi

# 1. Set Supabase secrets
echo -e "\n${GREEN}📝 Setting Supabase secrets...${NC}"
supabase secrets set ALLOWED_ORIGINS=https://safariticket-supabas-uoch.bolt.host
supabase secrets set PII_ENCRYPTION_KEY=Xl7kNq4Vv3n2L8jP0bY5z1mGf9sR6cTwH8aDeUqJpK0=
supabase secrets set TICKET_SIGNING_KEYS="K2:ACTIVE:3tYq9vL8Rk2Nw7HxP5mZc4FdJ1Qs6BaX9EuGv2Lp8Mn4Cr7Tw5"
supabase secrets set GATE_PROVISIONING_TOKEN=gate_Q7mLp2Xv9Rs4Hk8Nc5Tw1Za6Bj3Ef0Yu8Pd6Kv2Mx9Ln5Hr4

echo -e "\n${GREEN}✅ Supabase secrets set successfully!${NC}"

# 2. Create .env file for Bolt/Node
echo -e "\n${GREEN}📝 Creating .env file for Bolt...${NC}"
cat > .env << 'EOF'
# Supabase Configuration
SUPABASE_URL=your-project-url.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Application Secrets
ALLOWED_ORIGINS=https://safariticket-supabas-uoch.bolt.host
PII_ENCRYPTION_KEY=Xl7kNq4Vv3n2L8jP0bY5z1mGf9sR6cTwH8aDeUqJpK0=
TICKET_SIGNING_KEYS=K2:ACTIVE:3tYq9vL8Rk2Nw7HxP5mZc4FdJ1Qs6BaX9EuGv2Lp8Mn4Cr7Tw5
GATE_PROVISIONING_TOKEN=gate_Q7mLp2Xv9Rs4Hk8Nc5Tw1Za6Bj3Ef0Yu8Pd6Kv2Mx9Ln5Hr4
EOF

echo -e "\n${GREEN}✅ .env file created!${NC}"

# 3. Create a Supabase config file
echo -e "\n${GREEN}📝 Creating supabase/config.json...${NC}"
mkdir -p supabase
cat > supabase/config.json << 'EOF'
{
  "projectId": "your-project-id",
  "secrets": {
    "ALLOWED_ORIGINS": "https://safariticket-supabas-uoch.bolt.host",
    "PII_ENCRYPTION_KEY": "Xl7kNq4Vv3n2L8jP0bY5z1mGf9sR6cTwH8aDeUqJpK0=",
    "TICKET_SIGNING_KEYS": "K2:ACTIVE:3tYq9vL8Rk2Nw7HxP5mZc4FdJ1Qs6BaX9EuGv2Lp8Mn4Cr7Tw5",
    "GATE_PROVISIONING_TOKEN": "gate_Q7mLp2Xv9Rs4Hk8Nc5Tw1Za6Bj3Ef0Yu8Pd6Kv2Mx9Ln5Hr4"
  }
}
EOF

echo -e "\n${GREEN}✅ All secrets configured!${NC}"

# Instructions
echo -e "\n${YELLOW}📋 NEXT STEPS:${NC}"
echo "1. Update the .env file with your actual Supabase credentials"
echo "2. In Bolt dashboard, add these environment variables manually"
echo "3. Verify secrets with: supabase secrets list"
echo "4. Redeploy your Bolt application"
echo ""
echo "⚠️  Important: Keep these secrets secure and never commit them to git!"

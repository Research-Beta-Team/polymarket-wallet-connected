# How to Upload to GitHub

Follow these steps to upload your project to GitHub:

## Step 1: Initialize Git Repository

```bash
# Initialize git repository
git init

# Add all files
git add .

# Create initial commit
git commit -m "Initial commit: BTC/USD streaming platform with Polymarket events"
```

## Step 2: Create GitHub Repository

1. Go to [GitHub.com](https://github.com) and sign in
2. Click the **"+"** icon in the top right corner
3. Select **"New repository"**
4. Fill in the details:
   - **Repository name**: `polymarket-streaming` (or your preferred name)
   - **Description**: "BTC/USD streaming platform using Polymarket RTDS"
   - **Visibility**: Choose Public or Private
   - **DO NOT** initialize with README, .gitignore, or license (we already have these)
5. Click **"Create repository"**

## Step 3: Connect and Push to GitHub

After creating the repository, GitHub will show you commands. Use these:

```bash
# Add the remote repository (replace YOUR_USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR_USERNAME/polymarket-streaming.git

# Rename branch to main (if needed)
git branch -M main

# Push to GitHub
git push -u origin main
```

## Alternative: Using SSH

If you prefer SSH (and have SSH keys set up):

```bash
git remote add origin git@github.com:YOUR_USERNAME/polymarket-streaming.git
git branch -M main
git push -u origin main
```

## Step 4: Verify

Go to your GitHub repository page and verify all files are uploaded correctly.

## Future Updates

When you make changes, use these commands:

```bash
# Stage changes
git add .

# Commit changes
git commit -m "Description of your changes"

# Push to GitHub
git push
```

## Troubleshooting

If you get authentication errors:
- For HTTPS: Use a Personal Access Token instead of password
- For SSH: Make sure your SSH key is added to GitHub

To generate a Personal Access Token:
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `repo` permissions
3. Use the token as your password when pushing



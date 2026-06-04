const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string
const REGION    = import.meta.env.VITE_AWS_REGION as string ?? 'us-east-1'
const TOKEN_KEY = 'cvpr_access_token'

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch(
    `https://cognito-idp.${REGION}.amazonaws.com/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    }
  )

  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.message ?? 'Login failed')
  }

  const data = await res.json()
  const token = data.AuthenticationResult?.AccessToken
  if (!token) throw new Error('No token returned')
  sessionStorage.setItem(TOKEN_KEY, token)
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function isLoggedIn(): boolean {
  return !!getToken()
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY)
}

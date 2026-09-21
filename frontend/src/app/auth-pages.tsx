import { useNavigate } from 'react-router-dom';
import { Editor } from './forms';
import { useSession } from './session';
export function SignIn() {
  const { write, session } = useSession();
  const navigate = useNavigate();
  return (
    <>
      <p className="eyebrow">YOUR STORE WORKSPACE</p>
      <h1>{session ? 'Signed in' : 'Sign in'}</h1>
      {session ? (
        <p>Welcome, {session.user.displayName}.</p>
      ) : (
        <Editor
          title="Use your store account"
          submit="Sign in"
          fields={[
            { key: 'username', label: 'Username' },
            { key: 'password', label: 'Password', type: 'password' },
          ]}
          save={async (data) => {
            await write('/auth/login', data);
            navigate('/catalog');
          }}
        />
      )}
    </>
  );
}
export function PasswordChange() {
  const { write } = useSession();
  return (
    <>
      <h1>Change password</h1>
      <p>
        Use at least 12 characters. All sessions will end after this change.
      </p>
      <Editor
        title="Your password"
        fields={[
          {
            key: 'currentPassword',
            label: 'Current password',
            type: 'password',
          },
          { key: 'password', label: 'New password', type: 'password' },
        ]}
        save={(data) => write('/auth/password', data)}
      />
    </>
  );
}
export function Locked() {
  const { session, write } = useSession();
  return (
    <>
      <h1>Workstation locked</h1>
      <p>{session?.user.displayName}, enter your password to continue.</p>
      <Editor
        title="Unlock"
        submit="Unlock"
        fields={[{ key: 'password', label: 'Password', type: 'password' }]}
        save={(data) => write('/auth/unlock', data)}
      />
    </>
  );
}

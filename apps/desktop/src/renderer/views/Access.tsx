import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { codeProblem, emailProblem, newPasswordProblem, type AccountState } from '../../shared/account.js';
import { AccessFrame } from '../components/AccessFrame.js';
import { PasswordField } from '../components/PasswordField.js';
import { useAction } from '../lib/action.js';
import { tr } from '../i18n.js';

/** Pasos del acceso. El correo se conserva al pasar de uno a otro. */
type Step =
  | { kind: 'signIn' }
  | { kind: 'signUp' }
  /** Esperando a que pulse el enlace del correo; con la contraseña se entra al volver. */
  | { kind: 'confirm'; sent: boolean; password: string; remember: boolean }
  | { kind: 'forgot' }
  | { kind: 'reset' };

/** Espera antes de poder pedir otro correo (Supabase limita los correos por hora). */
const RESEND_WAIT_S = 60;

interface Ctx {
  email: string;
  setEmail: (v: string) => void;
  go: (step: Step) => void;
  /** Ejecuta una acción mostrando su error (si lo hay) en el formulario. */
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
  error: string | null;
}

/**
 * Inicio de sesión, registro, confirmación del correo y recuperación de la
 * contraseña. Cuando la sesión se inicia, el proceso principal avisa y la
 * aplicación aparece sola (Root.tsx).
 */
export function Access({ state }: { state: Extract<AccountState, { status: 'signed-out' | 'password-reset' }> }) {
  const [step, setStep] = useState<Step>({ kind: 'signIn' });
  const [email, setEmail] = useState('');
  const { busy, error, setError, run } = useAction();

  const go = useCallback(
    (next: Step) => {
      setError(null);
      setStep(next);
    },
    [setError],
  );
  const ctx: Ctx = { email, setEmail, go, run, busy, error };

  let form: ReactNode;
  if (state.status === 'password-reset') form = <NewPasswordForm ctx={ctx} email={state.email} />;
  else if (step.kind === 'signUp') form = <SignUpForm ctx={ctx} />;
  else if (step.kind === 'confirm') form = <ConfirmForm ctx={ctx} step={step} />;
  else if (step.kind === 'forgot') form = <ForgotForm ctx={ctx} />;
  else if (step.kind === 'reset') form = <ResetForm ctx={ctx} />;
  else form = <SignInForm ctx={ctx} />;

  return <AccessFrame>{form}</AccessFrame>;
}

/** Formulario de acceso: campos, el error (junto al botón) y enlaces a otros pasos. */
function Form({ ctx, title, intro, submit, onSubmit, links, children }: { ctx: Ctx; title: string; intro?: ReactNode; submit: string; onSubmit: () => void; links: ReactNode; children?: ReactNode }) {
  return (
    <form
      className="access-form"
      aria-labelledby="titulo-acceso"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 id="titulo-acceso">{title}</h2>
      {intro ? <p className="access-intro">{intro}</p> : null}
      {children}
      {ctx.error ? (
        <p className="form-error" role="alert">
          {ctx.error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={ctx.busy}>
        {submit}
      </button>
      <div className="access-links">{links}</div>
    </form>
  );
}

function EmailField({ ctx, autoFocus = true }: { ctx: Ctx; autoFocus?: boolean }) {
  return (
    <div className="field">
      <label htmlFor="correo">{tr('Correo', 'Email')}</label>
      <input id="correo" className="input" type="email" value={ctx.email} onChange={(e) => ctx.setEmail(e.target.value)} autoComplete="email" spellCheck={false} autoFocus={autoFocus} required />
    </div>
  );
}

/** Comprueba en el formulario antes de enviar; el servidor tiene la última palabra. */
function firstProblem(...problems: Array<string | null>): string | null {
  return problems.find((p) => p !== null) ?? null;
}

function SignInForm({ ctx }: { ctx: Ctx }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(emailProblem(ctx.email, tr), password === '' ? tr('Escribe tu contraseña.', 'Enter your password.') : null);
      if (problem) throw new Error(problem);
      const r = await window.radar.account.signIn(ctx.email, password, remember);
      if (r.confirmEmail) ctx.go({ kind: 'confirm', sent: false, password, remember });
    });
  return (
    <Form
      ctx={ctx}
      title={tr('Inicia sesión', 'Sign in')}
      submit={tr('Iniciar sesión', 'Sign in')}
      onSubmit={submit}
      links={
        <>
          <button type="button" className="link" onClick={() => ctx.go({ kind: 'forgot' })}>
            {tr('¿Olvidaste tu contraseña?', 'Forgot your password?')}
          </button>
          <span>
            {tr('¿No tienes cuenta?', 'No account?')}{' '}
            <button type="button" className="link" onClick={() => ctx.go({ kind: 'signUp' })}>
              {tr('Crear una', 'Create one')}
            </button>
          </span>
        </>
      }
    >
      <EmailField ctx={ctx} />
      <PasswordField label={tr('Contraseña', 'Password')} value={password} onChange={setPassword} autoComplete="current-password" />
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>{tr('Seguir conectado en este equipo', 'Stay signed in on this computer')}</span>
      </label>
    </Form>
  );
}

function SignUpForm({ ctx }: { ctx: Ctx }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(emailProblem(ctx.email, tr), newPasswordProblem(password, tr), password !== repeat ? tr('Las dos contraseñas no coinciden.', 'The two passwords do not match.') : null);
      if (problem) throw new Error(problem);
      const r = await window.radar.account.signUp(ctx.email, password);
      if (r.confirmEmail) ctx.go({ kind: 'confirm', sent: true, password, remember: true });
    });
  return (
    <Form
      ctx={ctx}
      title={tr('Crea tu cuenta', 'Create your account')}
      intro={tr(
        'Con tu cuenta, tus proyectos, tu historial y tus claves de IA quedan separados de los de otras personas que usen este equipo.',
        'With your account, your projects, history and AI keys stay separate from those of other people using this computer.',
      )}
      submit={tr('Crear cuenta', 'Create account')}
      onSubmit={submit}
      links={
        <span>
          {tr('¿Ya tienes cuenta?', 'Already have an account?')}{' '}
          <button type="button" className="link" onClick={() => ctx.go({ kind: 'signIn' })}>
            {tr('Inicia sesión', 'Sign in')}
          </button>
        </span>
      }
    >
      <EmailField ctx={ctx} />
      <PasswordField label={tr('Contraseña', 'Password')} value={password} onChange={setPassword} autoComplete="new-password" hint={tr('Al menos 8 caracteres.', 'At least 8 characters.')} />
      <PasswordField label={tr('Repite la contraseña', 'Repeat the password')} value={repeat} onChange={setRepeat} autoComplete="new-password" />
    </Form>
  );
}

/** Confirmación con el enlace del correo: se pulsa en el navegador y, al volver, se entra con la contraseña. */
function ConfirmForm({ ctx, step }: { ctx: Ctx; step: Extract<Step, { kind: 'confirm' }> }) {
  const resend = useResend(step.sent);
  const submit = () =>
    void ctx.run(async () => {
      const r = await window.radar.account.signIn(ctx.email, step.password, step.remember);
      if (r.confirmEmail) throw new Error(tr('Tu correo aún no está confirmado. Pulsa el enlace del mensaje que te enviamos y vuelve a intentarlo.', 'Your email is not confirmed yet. Click the link in the message we sent you and try again.'));
    });
  return (
    <Form
      ctx={ctx}
      title={tr('Confirma tu correo', 'Confirm your email')}
      intro={
        step.sent ? (
          <>
            {tr('Te enviamos un enlace a', 'We sent a link to')} <strong>{ctx.email.trim()}</strong>.{' '}
            {tr(
              'Púlsalo y vuelve aquí para entrar. Si no llega en unos minutos, revisa el correo no deseado. Si ya tenías una cuenta con ese correo, inicia sesión.',
              'Click it and come back here to sign in. If it does not arrive in a few minutes, check your spam folder. If you already had an account with that email, sign in.',
            )}
          </>
        ) : (
          <>
            {tr('La cuenta', 'The account')} <strong>{ctx.email.trim()}</strong>{' '}
            {tr(
              'aún no confirmó su correo. Pulsa el enlace del mensaje de confirmación y vuelve aquí para entrar. Si no lo encuentras, pide otro.',
              'has not confirmed its email yet. Click the link in the confirmation message and come back here to sign in. If you cannot find it, request another one.',
            )}
          </>
        )
      }
      submit={tr('Ya lo confirmé: entrar', 'I confirmed it: sign in')}
      onSubmit={submit}
      links={
        <>
          <button type="button" className="link" disabled={ctx.busy || resend.wait > 0} onClick={() => void ctx.run(async () => resend.send(() => window.radar.account.resendConfirmation(ctx.email)))}>
            {resend.label(step.sent ? tr('Reenviar el correo', 'Resend the email') : tr('Enviar otro correo', 'Send another email'))}
          </button>
          <BackToSignIn ctx={ctx} />
        </>
      }
    />
  );
}

function ForgotForm({ ctx }: { ctx: Ctx }) {
  const submit = () =>
    void ctx.run(async () => {
      const problem = emailProblem(ctx.email, tr);
      if (problem) throw new Error(problem);
      await window.radar.account.requestPasswordReset(ctx.email);
      ctx.go({ kind: 'reset' });
    });
  return (
    <Form
      ctx={ctx}
      title={tr('Recupera tu contraseña', 'Recover your password')}
      intro={tr('Escribe el correo de tu cuenta. Te enviaremos un código para elegir una contraseña nueva.', 'Enter the email of your account. We will send you a code to choose a new password.')}
      submit={tr('Enviar el código', 'Send the code')}
      onSubmit={submit}
      links={<BackToSignIn ctx={ctx} />}
    >
      <EmailField ctx={ctx} />
    </Form>
  );
}

function ResetForm({ ctx }: { ctx: Ctx }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const resend = useResend(true);
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(codeProblem(code, tr), newPasswordProblem(password, tr), password !== repeat ? tr('Las dos contraseñas no coinciden.', 'The two passwords do not match.') : null);
      if (problem) throw new Error(problem);
      await window.radar.account.resetPassword(ctx.email, code, password);
    });
  return (
    <Form
      ctx={ctx}
      title={tr('Elige una contraseña nueva', 'Choose a new password')}
      intro={
        <>
          {tr('Si', 'If')} <strong>{ctx.email.trim()}</strong>{' '}
          {tr('tiene una cuenta, le llegará un código. Escríbelo con tu contraseña nueva.', 'has an account, a code will arrive there. Enter it with your new password.')}
        </>
      }
      submit={tr('Guardar la contraseña', 'Save the password')}
      onSubmit={submit}
      links={
        <>
          <button type="button" className="link" disabled={ctx.busy || resend.wait > 0} onClick={() => void ctx.run(async () => resend.send(() => window.radar.account.requestPasswordReset(ctx.email)))}>
            {resend.label(tr('Reenviar el código', 'Resend the code'))}
          </button>
          <BackToSignIn ctx={ctx} />
        </>
      }
    >
      <CodeField value={code} onChange={setCode} />
      <PasswordField label={tr('Contraseña nueva', 'New password')} value={password} onChange={setPassword} autoComplete="new-password" hint={tr('Al menos 8 caracteres.', 'At least 8 characters.')} />
      <PasswordField label={tr('Repite la contraseña', 'Repeat the password')} value={repeat} onChange={setRepeat} autoComplete="new-password" />
    </Form>
  );
}

/** El código ya se comprobó, pero Supabase rechazó la contraseña: se elige otra. */
function NewPasswordForm({ ctx, email }: { ctx: Ctx; email: string }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const submit = () =>
    void ctx.run(async () => {
      const problem = firstProblem(newPasswordProblem(password, tr), password !== repeat ? tr('Las dos contraseñas no coinciden.', 'The two passwords do not match.') : null);
      if (problem) throw new Error(problem);
      await window.radar.account.setNewPassword(password);
    });
  return (
    <Form
      ctx={ctx}
      title={tr('Elige una contraseña nueva', 'Choose a new password')}
      intro={
        <>
          {tr('El código de', 'The code for')} <strong>{email}</strong>{' '}
          {tr('es válido. Elige la contraseña con la que entrarás a partir de ahora.', 'is valid. Choose the password you will sign in with from now on.')}
        </>
      }
      submit={tr('Guardar la contraseña', 'Save the password')}
      onSubmit={submit}
      links={
        <button type="button" className="link" onClick={() => void ctx.run(async () => void (await window.radar.account.signOut()))}>
          {tr('Cancelar', 'Cancel')}
        </button>
      }
    >
      <PasswordField label={tr('Contraseña nueva', 'New password')} value={password} onChange={setPassword} autoComplete="new-password" hint={tr('Al menos 8 caracteres.', 'At least 8 characters.')} autoFocus />
      <PasswordField label={tr('Repite la contraseña', 'Repeat the password')} value={repeat} onChange={setRepeat} autoComplete="new-password" />
    </Form>
  );
}

function BackToSignIn({ ctx }: { ctx: Ctx }) {
  return (
    <button type="button" className="link" onClick={() => ctx.go({ kind: 'signIn' })}>
      {tr('Volver a iniciar sesión', 'Back to sign in')}
    </button>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="codigo">{tr('Código del correo', 'Code from the email')}</label>
      <input
        id="codigo"
        className="input mono code-input"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        autoFocus
        required
      />
    </div>
  );
}

/** Botón de reenviar con espera: Supabase limita los correos (2 por hora con su servidor de serie). */
function useResend(justSent: boolean) {
  const [wait, setWait] = useState(justSent ? RESEND_WAIT_S : 0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  return {
    wait,
    label: (text: string) => (wait > 0 ? `${text} ${tr(`(en ${wait} s)`, `(in ${wait} s)`)}` : text),
    send: async (fn: () => Promise<null>) => {
      await fn();
      setWait(RESEND_WAIT_S);
    },
  };
}

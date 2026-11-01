import React, { useState } from 'react';
import { AdminAPI } from '../../services/api';
import { AdminUser } from '../../types';
import {
  IconLogo,
  IconShield,
  IconMail,
  IconLock,
  IconEye,
  IconEyeOff,
  IconAlert,
} from '../Icons';

interface LoginViewProps {
  onLoginSuccess: (admin: AdminUser) => void;
}

type Step = 'credentials' | 'otp' | 'enroll' | 'mfa';

/**
 * The backend has no dev-login shortcut — every sign-in walks the real
 * ceremony: password -> emailed 6-digit code -> a TOTP factor (enrolling one
 * on the first-ever sign-in, or just proving an existing one after that).
 * `loginId` is the thread connecting the steps; it lives only in this
 * component's state and is lost on refresh by design (see the backend's
 * README — a client that still holds it can resume with `{step:'state'}`,
 * but a lost one simply restarts here).
 */
export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [loginId, setLoginId] = useState('');
  const [resendHint, setResendHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep('credentials');
    setLoginId('');
    setOtpCode('');
    setTotpCode('');
    setTotpSecret('');
    setTotpUri('');
    setResendHint(null);
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await AdminAPI.loginWithPassword(email, password);
      if (!res.success) {
        setError(res.error || 'Authentication failed. Please verify credentials.');
        return;
      }
      // A trusted device (or any factor the backend decides is already
      // satisfied) can skip straight to a session on step 1 — this is not an
      // edge case to special-case away, it is a normal outcome of the same
      // `POST /auth/login` this form always calls.
      if (res.outcome === 'session' && res.session) {
        onLoginSuccess(AdminAPI.completeSession(res.session));
      } else if (res.outcome === 'email_otp_required' && res.loginId) {
        setLoginId(res.loginId);
        setStep('otp');
      } else {
        setError('Unexpected response from the server.');
      }
    } catch {
      setError('An error occurred during authentication.');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await AdminAPI.verifyEmailOtp(loginId, otpCode);
      if (!res.success) {
        setError(res.error || 'Invalid or expired code.');
        return;
      }
      if (res.outcome === 'session' && res.session) {
        onLoginSuccess(AdminAPI.completeSession(res.session));
      } else if (res.outcome === 'mfa_required') {
        setStep('mfa');
      } else if (res.outcome === 'enrollment_required') {
        const enroll = await AdminAPI.totpEnroll(loginId);
        if (enroll.success && enroll.totp) {
          setTotpSecret(enroll.totp.secret);
          setTotpUri(enroll.totp.uri);
          setStep('enroll');
        } else {
          setError(enroll.error || 'Could not start authenticator enrollment.');
        }
      } else {
        setError('Unexpected response from the server.');
      }
    } catch {
      setError('An error occurred verifying the code.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
    setError(null);
    setResendHint(null);
    const res = await AdminAPI.resendOtp(loginId);
    if (res.success) {
      setResendHint('A new code has been sent.');
    } else {
      setError(res.error || 'Could not resend the code.');
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await AdminAPI.totpVerify(loginId, totpCode);
      if (res.success && res.admin) {
        onLoginSuccess(res.admin);
      } else {
        setError(res.error || 'Invalid authenticator code.');
      }
    } catch {
      setError('An error occurred completing sign-in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <div className="login-backdrop-glow login-glow-1"></div>
      <div className="login-backdrop-glow login-glow-2"></div>

      <div className="login-container">
        {/* Brand Header */}
        <div className="login-header">
          <div className="login-brand-icon">
            <IconLogo size={36} />
          </div>
          <h1 className="login-title">OREBiT Admin Studio</h1>
          <p className="login-subtitle">
            Chat Management & Platform Security Control Center
          </p>
          <div className="login-security-badge">
            <IconShield size={13} color="var(--primary)" />
            <span>Restricted Access &bull; Authorized Personnel Only</span>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="login-error-alert">
            <IconAlert size={16} color="var(--danger)" />
            <span>{error}</span>
          </div>
        )}

        {step === 'credentials' && (
          <form className="login-form" onSubmit={handleCredentialsSubmit}>
            <div className="form-group">
              <label className="form-label">Admin Email Address</label>
              <div className="input-icon-wrapper">
                <span className="input-leading-icon">
                  <IconMail size={16} />
                </span>
                <input
                  type="email"
                  className="form-control with-leading-icon"
                  placeholder="admin@orebit.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Admin Password</label>
              <div className="input-icon-wrapper">
                <span className="input-leading-icon">
                  <IconLock size={16} />
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="form-control with-leading-icon with-trailing-icon"
                  placeholder="Enter master password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="input-trailing-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" className="btn-action login-submit-btn" disabled={loading}>
              {loading ? (
                <span className="btn-loading-content">
                  <span className="spinner-border"></span>
                  <span>Authenticating...</span>
                </span>
              ) : (
                <span className="btn-normal-content">
                  <IconShield size={16} />
                  <span>Continue</span>
                </span>
              )}
            </button>
          </form>
        )}

        {step === 'otp' && (
          <form className="login-form" onSubmit={handleOtpSubmit}>
            <p className="login-subtitle" style={{ marginBottom: 0 }}>
              We emailed a 6-digit code to <strong>{email}</strong>. It expires in 10 minutes.
            </p>
            <div className="form-group">
              <label className="form-label">Verification Code</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="form-control"
                placeholder="000000"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
              />
            </div>

            {resendHint && <p className="login-subtitle" style={{ marginBottom: 0 }}>{resendHint}</p>}

            <button type="submit" className="btn-action login-submit-btn" disabled={loading || otpCode.length !== 6}>
              {loading ? (
                <span className="btn-loading-content">
                  <span className="spinner-border"></span>
                  <span>Verifying...</span>
                </span>
              ) : (
                <span className="btn-normal-content">
                  <IconShield size={16} />
                  <span>Verify Code</span>
                </span>
              )}
            </button>

            <div className="helper-header" style={{ marginTop: 4 }}>
              <button type="button" className="quick-fill-btn" onClick={handleResendOtp}>
                Resend code
              </button>
              <button type="button" className="quick-fill-btn" onClick={reset}>
                Start over
              </button>
            </div>
          </form>
        )}

        {step === 'enroll' && (
          <form className="login-form" onSubmit={handleTotpSubmit}>
            <p className="login-subtitle" style={{ marginBottom: 0 }}>
              First sign-in: set up an authenticator app (Google Authenticator, Authy, 1Password, ...).
              Add a new account and enter this key manually.
            </p>
            <div className="helper-credentials-box">
              <div className="cred-row">
                <span className="cred-label">Secret</span>
                <span className="cred-val">{totpSecret}</span>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">6-digit Code From Authenticator</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="form-control"
                placeholder="000000"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
              />
            </div>

            <button type="submit" className="btn-action login-submit-btn" disabled={loading || totpCode.length !== 6}>
              {loading ? (
                <span className="btn-loading-content">
                  <span className="spinner-border"></span>
                  <span>Confirming...</span>
                </span>
              ) : (
                <span className="btn-normal-content">
                  <IconShield size={16} />
                  <span>Confirm & Enter Console</span>
                </span>
              )}
            </button>

            <div className="helper-header" style={{ marginTop: 4 }}>
              <button type="button" className="quick-fill-btn" onClick={reset}>
                Start over
              </button>
            </div>
          </form>
        )}

        {step === 'mfa' && (
          <form className="login-form" onSubmit={handleTotpSubmit}>
            <p className="login-subtitle" style={{ marginBottom: 0 }}>
              Enter the current 6-digit code from your authenticator app.
            </p>
            <div className="form-group">
              <label className="form-label">Authenticator Code</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="form-control"
                placeholder="000000"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
              />
            </div>

            <button type="submit" className="btn-action login-submit-btn" disabled={loading || totpCode.length !== 6}>
              {loading ? (
                <span className="btn-loading-content">
                  <span className="spinner-border"></span>
                  <span>Verifying...</span>
                </span>
              ) : (
                <span className="btn-normal-content">
                  <IconShield size={16} />
                  <span>Enter Admin Console</span>
                </span>
              )}
            </button>

            <div className="helper-header" style={{ marginTop: 4 }}>
              <button type="button" className="quick-fill-btn" onClick={reset}>
                Start over
              </button>
            </div>
          </form>
        )}

        {/* Footer */}
        <div className="login-footer">
          <span>OREBiT System Protocol v3.2 &bull; Encrypted TLS Session</span>
        </div>
      </div>
    </div>
  );
};

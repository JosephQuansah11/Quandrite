import { useState } from 'react';
import { Button } from '@/ui/Button';
import { Field, FormActions } from '@/ui/Field';
import { Pill } from '@/ui/Pill';
import { toast } from '@/services/notify';

/**
 * The landing page: who you are, which room, and what you are there to do.
 *
 * One form, one action. The role decides what the room lets you do, so it is asked here
 * rather than being a surprise later.
 */
export function JoinPage({ session }: { session: any }) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState(new URLSearchParams(location.search).get('room') ?? '');
  const [role, setRole] = useState('participant');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: any) {
    event.preventDefault();
    if (!name.trim()) return toast('Your name is needed first', 'warn');
    setBusy(true);
    try {
      await session.join({ name: name.trim(), roomId: roomId.trim() || undefined, role, password });
    } catch (error: any) {
      toast(error?.message || 'Could not join that room', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page page-join">
      <header className="brand">
        <div className="brand-mark">Q</div>
        <div>
          <h1>Quandrite</h1>
          <p className="muted">meetings - chat - multi-platform streaming</p>
        </div>
        <Pill text={session.state.connected ? 'online' : 'connecting'} tone={session.state.connected ? 'ok' : 'neutral'} />
      </header>

      <form className="card join-form" onSubmit={submit}>
        <Field label="Your name" value={name} onChange={setName} placeholder="Ada Lovelace" autoFocus />
        <Field label="Room" value={roomId} onChange={setRoomId} placeholder="leave empty for a new room" hint="Share the code and the same room opens for everyone." />
        <Field label="Join as" as="select" value={role} onChange={setRole}>
          <option value="host">Host - run the broadcast</option>
          <option value="cohost">Co-host - help run it</option>
          <option value="participant">Participant</option>
          <option value="viewer">Viewer - watch only</option>
        </Field>
        <Field label="Password" type="password" value={password} onChange={setPassword} hint="Only needed if the room has one." />
        <FormActions>
          <Button label={busy ? 'Joining...' : 'Join'} icon="play" variant="primary" disabled={busy} />
        </FormActions>
      </form>
    </main>
  );
}

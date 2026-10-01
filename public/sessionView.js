// Maps Live session events onto the transcript and the speaker, and marks the
// start of each new session in the transcript.

// An extended-thinking model ends a turn with interactionStatus IN_PROGRESS
// while it keeps working on the same reply; only other statuses (or none)
// finish the reply.
export function isReplyEnd(ev) {
  return ev.interactionStatus !== 'IN_PROGRESS';
}

export function createSessionView({ transcript, player, now = () => new Date() }) {
  let last = 'idle';
  return {
    handle(ev) {
      switch (ev.type) {
        // Only connecting -> live starts a session; reconnecting -> live resumes the same conversation.
        case 'state':
          if (ev.state === 'live' && last === 'connecting') transcript.divider(`New session started · ${now().toLocaleTimeString()}`);
          last = ev.state;
          break;
        case 'audio': player.enqueue(ev.data); break;
        case 'input_transcript': transcript.appendStream('you', ev.text); break;
        case 'output_transcript': transcript.appendStream('gemini', ev.text); break;
        case 'turn_complete': if (isReplyEnd(ev)) transcript.endTurn(); break;
        case 'interrupted': player.flush(); transcript.endTurn(); break;
        case 'tool_call': transcript.add('tool_call', ev.args, { name: ev.name }); break;
        case 'tool_result': transcript.add('tool_result', ev.result, { name: ev.name }); break;
        case 'tool_cancelled': transcript.add('status', `Tool call cancelled (${ev.ids.join(', ')})`); break;
      }
    },
  };
}

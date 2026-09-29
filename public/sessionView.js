// Maps Live session events (other than state changes) onto the transcript
// and the speaker.

// An extended-thinking model ends a turn with interactionStatus IN_PROGRESS
// while it keeps working on the same reply; only other statuses (or none)
// finish the reply.
export function isReplyEnd(ev) {
  return ev.interactionStatus !== 'IN_PROGRESS';
}

export function createSessionView({ transcript, player }) {
  return {
    handle(ev) {
      switch (ev.type) {
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

const BASE_URL = import.meta.env.VITE_API_URL || "";

export async function analyzeRepo(repoUrl) {
  const response = await fetch(`${BASE_URL}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ repo_url: repoUrl })
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Backend returned ${response.status}`);
  }
  
  return response.json();
}

export function subscribeToJob(jobId, onEvent, onError, onDone) {
  const eventSource = new EventSource(`${BASE_URL}/jobs/${jobId}`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onEvent(data);
      
      if (data.status === 'done') {
        onDone(data);
        eventSource.close();
      } else if (data.status === 'error') {
        onError(data.error);
        eventSource.close();
      }
    } catch (err) {
      onError('Failed to parse SSE event');
      eventSource.close();
    }
  };
  
  eventSource.onerror = () => {
    onError('Connection lost');
    eventSource.close();
  };
  
  return () => {
    eventSource.close();
  };
}

export async function fetchGraph(jobId) {
  const response = await fetch(`${BASE_URL}/graph/${jobId}`);
  
  if (response.status === 202) {
    throw new Error("Analysis still in progress");
  }
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to fetch graph (${response.status})`);
  }
  
  return response.json();
}

export async function fetchRepo(owner, repo) {
  const response = await fetch(`${BASE_URL}/repo/${owner}/${repo}`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Backend returned ${response.status}`);
  }
  return response.json();
}

export async function fetchRepoMeta(owner, repo) {
  const response = await fetch(`${BASE_URL}/repo/${owner}/${repo}/meta`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Backend returned ${response.status}`);
  }
  return response.json();
}

export async function fetchFileSource(jobId, filePath) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${BASE_URL}/source/${jobId}/${encodedPath}`);
  if (!res.ok) throw new Error(`Failed to fetch source: ${res.status}`);
  return res.json();
}

export function streamChatMessage(jobId, message, history, onToken, onDone, onError) {
  fetch(`${BASE_URL}/chat/${jobId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history })
  })
  .then(async res => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      onError(err.error || err.detail || `Chat failed: ${res.status}`);
      return;
    }
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    
    async function readStream() {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const text = decoder.decode(value);
        const lines = text.split("\n");
        
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.done) {
              onDone(data.nodes || []);
            } else {
              onToken(data.token);
            }
          } catch (e) {
            // ignore JSON parse errors from partial chunks
          }
        }
      }
    }
    readStream();
  })
  .catch(err => onError(err.message));
}

export async function fetchChatSuggestions(jobId) {
  try {
    const res = await fetch(`${BASE_URL}/chat/${jobId}/suggestions`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.suggestions || [];
  } catch {
    return [];
  }
}

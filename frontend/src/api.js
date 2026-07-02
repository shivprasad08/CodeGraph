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

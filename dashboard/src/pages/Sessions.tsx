import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, QrCode, RefreshCw, Trash2, Eye, Loader2, Play, Square, X, Search, Filter } from 'lucide-react';
import { sessionApi, type Session } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../components/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import './Sessions.css';

export function Sessions() {
  useDocumentTitle('Sessions');
  const toast = useToast();
  const { canWrite } = useRole();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [qrData, setQrData] = useState<{ sessionId: string; sessionName: string; qrCode: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // WebSocket for real-time session updates
  useWebSocket({
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        // Update session status in real-time
        setSessions(prev =>
          prev.map(s => (s.id === event.sessionId ? { ...s, status: event.status as Session['status'] } : s)),
        );
        // Show toast for important status changes
        if (event.status === 'ready') {
          toast.success('Session Ready', 'WhatsApp session is now connected');
        } else if (event.status === 'disconnected') {
          toast.warning('Session Disconnected', 'WhatsApp session was disconnected');
        }
      },
      [toast],
    ),
  });

  const fetchSessions = async () => {
    try {
      setLoading(true);
      const data = await sessionApi.list();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  // Auto-refresh QR code every 5 seconds when modal is open
  const qrRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentSessionName = useRef<string>('');

  const fetchQR = useCallback(async (sessionId: string) => {
    try {
      const qr = await sessionApi.getQR(sessionId);
      setQrData({ sessionId, sessionName: currentSessionName.current, qrCode: qr.qrCode });
      // Check if session became ready
      if (qr.status === 'ready') {
        setQrData(null);
        currentSessionName.current = '';
        fetchSessions();
      }
    } catch {
      // QR not available or session already connected - stop polling
      setQrData(null);
      currentSessionName.current = '';
      fetchSessions();
    }
  }, []);

  useEffect(() => {
    if (qrData) {
      // Preserve session name in ref for polling
      currentSessionName.current = qrData.sessionName;
      // Start polling for QR updates
      qrRefreshInterval.current = setInterval(() => {
        fetchQR(qrData.sessionId);
      }, 5000);
    }
    return () => {
      if (qrRefreshInterval.current) {
        clearInterval(qrRefreshInterval.current);
      }
    };
  }, [qrData, fetchQR]);

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    try {
      setCreating(true);
      const newSession = await sessionApi.create(newSessionName);
      setSessions([...sessions, newSession]);
      setNewSessionName('');
      setShowCreateModal(false);
      toast.success('Session Created', `Session "${newSession.name}" created successfully`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create session';
      setError(msg);
      toast.error('Create Failed', msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    try {
      await sessionApi.delete(id);
      setSessions(sessions.filter(s => s.id !== id));
      toast.success('Session Deleted', session ? `Session "${session.name}" deleted` : 'Session deleted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete session';
      console.error('Failed to delete:', err);
      toast.error('Delete Failed', msg);
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleStart = async (id: string) => {
    // Find session and check if it's already started
    const session = sessions.find(s => s.id === id);
    if (session && ['initializing', 'connecting', 'qr_ready'].includes(session.status)) {
      // Session already started, just show QR
      handleShowQR(id);
      return;
    }

    try {
      await sessionApi.start(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'connecting' } : s)));
      // Refresh sessions and then fetch QR
      await fetchSessions();
      handleShowQR(id);
    } catch (err) {
      console.error('Failed to start:', err);
      // Refresh sessions to get real status
      await fetchSessions();
      // If error is "already started", try to show QR anyway
      if (err instanceof Error && err.message.includes('already started')) {
        handleShowQR(id);
      }
    }
  };

  const handleShowQR = async (id: string) => {
    // Find session name
    const session = sessions.find(s => s.id === id);
    const sessionName = session?.name || 'Unknown Session';
    try {
      const qr = await sessionApi.getQR(id);
      setQrData({ sessionId: id, sessionName, qrCode: qr.qrCode });
    } catch (err) {
      console.error('Failed to get QR:', err);
      setError('QR code not available yet. Try again in a moment.');
    }
  };

  const handleStop = async (id: string) => {
    try {
      await sessionApi.stop(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      if (qrData?.sessionId === id) setQrData(null);
    } catch (err) {
      console.error('Failed to stop:', err);
      // Refresh sessions to get real status
      fetchSessions();
    }
  };

  const formatLastActive = (date?: string) => {
    if (!date) return 'Never';
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => {
    const statusMap: Record<string, string> = {
      created: 'New',
      idle: 'Idle',
      initializing: 'Starting...',
      connecting: 'Connecting...',
      qr_ready: 'Scan QR',
      ready: 'Connected',
      disconnected: 'Disconnected',
    };
    return statusMap[status] || status;
  };

  const filteredSessions = sessions.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && s.status === 'ready') ||
      (statusFilter === 'inactive' && ['created', 'idle', 'disconnected'].includes(s.status)) ||
      (statusFilter === 'connecting' && ['initializing', 'connecting', 'qr_ready'].includes(s.status));
    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return (
      <div
        className="sessions-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <PageHeader
        title="Sessions"
        subtitle="Manage your WhatsApp sessions and QR code connections"
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              New Session
            </button>
          )
        }
      />

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="active">Active (Connected)</option>
            <option value="inactive">Inactive</option>
            <option value="connecting">Connecting</option>
          </select>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: '#FEE2E2',
            padding: '1rem',
            borderRadius: '8px',
            color: '#DC2626',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Create New Session</h2>
              <button className="btn-icon" onClick={() => setShowCreateModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <label>Session Name</label>
              <input
                type="text"
                placeholder="e.g., marketing-bot"
                value={newSessionName}
                onChange={e => {
                  // Auto-convert to lowercase and replace spaces with hyphens
                  const value = e.target.value.toLowerCase().replace(/\s+/g, '-');
                  setNewSessionName(value);
                }}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
              <p className="input-hint">
                Use lowercase letters, numbers, and hyphens only. Example: <code>customer-support</code>,{' '}
                <code>bot-1</code>
              </p>
              {newSessionName && !/^[a-z0-9-]+$/.test(newSessionName) && (
                <p className="input-error">Invalid characters. Only lowercase letters, numbers, and hyphens allowed.</p>
              )}
              {newSessionName && newSessionName.length > 50 && (
                <p className="input-error">Name must be 50 characters or less ({newSessionName.length}/50).</p>
              )}
              {newSessionName &&
                /^[a-z0-9-]+$/.test(newSessionName) &&
                newSessionName.length <= 50 &&
                sessions.some(s => s.name === newSessionName) && (
                  <p className="input-error">Session with this name already exists.</p>
                )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={
                  creating ||
                  !newSessionName.trim() ||
                  !/^[a-z0-9-]+$/.test(newSessionName) ||
                  newSessionName.length > 50 ||
                  sessions.some(s => s.name === newSessionName)
                }
              >
                {creating ? <Loader2 className="animate-spin" size={16} /> : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Modal */}
      {qrData && (
        <div className="modal-overlay" onClick={() => setQrData(null)}>
          <div className="modal qr-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h2>Scan QR Code</h2>
                <span className="session-name">{qrData.sessionName}</span>
              </div>
              <button className="btn-close" onClick={() => setQrData(null)} aria-label="Close">
                <X size={20} color="#64748b" />
              </button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              {qrData.qrCode ? (
                <>
                  <img src={qrData.qrCode} alt="QR Code" style={{ maxWidth: '280px', borderRadius: '12px' }} />
                  <div className="qr-instructions">
                    <p className="qr-step">
                      <strong>1.</strong> Open WhatsApp on your phone
                    </p>
                    <p className="qr-step">
                      <strong>2.</strong> Tap <strong>Menu</strong> → <strong>Linked Devices</strong>
                    </p>
                    <p className="qr-step">
                      <strong>3.</strong> Tap <strong>Link a Device</strong> and scan this QR
                    </p>
                  </div>
                  <p className="qr-auto-refresh">
                    <RefreshCw size={14} className="spin-slow" /> QR updates automatically every 5 seconds
                  </p>
                </>
              ) : (
                <div style={{ padding: '2rem' }}>
                  <Loader2 className="animate-spin" size={48} />
                  <p>Generating QR code...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Session Detail Modal */}
      {selectedSession && (
        <div className="modal-overlay" onClick={() => setSelectedSession(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Session Details</h2>
              <button className="btn-icon" onClick={() => setSelectedSession(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">Name</span>
                  <span className="detail-value">{selectedSession.name}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Status</span>
                  <span className={`status-badge ${selectedSession.status}`}>{selectedSession.status}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Session ID</span>
                  <span className="detail-value mono">{selectedSession.id}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Phone Number</span>
                  <span className="detail-value">{selectedSession.phone || 'Not connected'}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Created</span>
                  <span className="detail-value">{new Date(selectedSession.createdAt).toLocaleString()}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Last Active</span>
                  <span className="detail-value">
                    {selectedSession.lastActive ? new Date(selectedSession.lastActive).toLocaleString() : 'Never'}
                  </span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setSelectedSession(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirmId && (
        <div className="modal-overlay" onClick={() => setDeleteConfirmId(null)}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Confirm Delete</h2>
              <button className="btn-icon" onClick={() => setDeleteConfirmId(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>
                Are you sure you want to delete session{' '}
                <strong>"{sessions.find(s => s.id === deleteConfirmId)?.name}"</strong>?
              </p>
              <p className="text-muted">This action cannot be undone.</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteConfirmId(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={() => handleDelete(deleteConfirmId)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="sessions-grid">
        {filteredSessions.length === 0 ? (
          <div className="empty-state">
            <QrCode size={48} />
            <h3>No sessions found</h3>
            <p>Create a new session to get started</p>
          </div>
        ) : (
          filteredSessions.map(session => (
            <div key={session.id} className="session-card">
              <div className="card-header">
                <h3 title={session.name}>{session.name}</h3>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
              </div>

              {session.status === 'initializing' || session.status === 'connecting' || session.status === 'qr_ready' ? (
                <div className="qr-placeholder">
                  <QrCode size={80} className="qr-icon" />
                  <p>{session.status === 'qr_ready' ? 'Scan QR code to connect' : 'Preparing QR code...'}</p>
                  <button
                    className="btn-sm"
                    onClick={() => handleShowQR(session.id)}
                    disabled={session.status !== 'qr_ready'}
                  >
                    {session.status === 'qr_ready' ? 'Show QR' : 'Loading...'}
                  </button>
                </div>
              ) : (
                <div className="session-info">
                  <div className="info-row">
                    <span className="info-label">Phone</span>
                    <span className="info-value">{session.phone || '—'}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Session ID</span>
                    <span className="info-value mono">{session.id.substring(0, 12)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Last Active</span>
                    <span className="info-value">{formatLastActive(session.lastActive)}</span>
                  </div>
                </div>
              )}

              <div className="card-actions">
                <button className="btn-action" onClick={() => setSelectedSession(session)}>
                  <Eye size={16} />
                  View
                </button>
                {canWrite &&
                (session.status === 'created' || session.status === 'idle' || session.status === 'disconnected') ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <Play size={16} />
                    Start
                  </button>
                ) : canWrite && ['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) ? (
                  <button className="btn-action" onClick={() => handleStop(session.id)}>
                    <Square size={16} />
                    Stop
                  </button>
                ) : canWrite ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <RefreshCw size={16} />
                    Reconnect
                  </button>
                ) : null}
                {canWrite && (
                  <button className="btn-action danger" onClick={() => setDeleteConfirmId(session.id)}>
                    <Trash2 size={16} />
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

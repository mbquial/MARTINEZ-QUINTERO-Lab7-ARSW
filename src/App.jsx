import { useEffect, useRef, useState } from 'react'
import { createSocket } from './lib/socketIoClient.js'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080'
const IO_BASE = import.meta.env.VITE_IO_BASE ?? 'http://localhost:3001'

function getPointCount(bp) {
  if (Array.isArray(bp?.points)) return bp.points.length
  if (typeof bp?.numberpoints === 'number') return bp.numberpoints
  if (typeof bp?.totalPoints === 'number') return bp.totalPoints
  return 0
}

function normalizeBlueprintList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.blueprints)) return payload.blueprints
  return []
}

function normalizePointsPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.points)) return payload.points
  if (payload?.point) return [payload.point]
  return []
}

function unwrapData(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data
  }
  return payload
}

function authHeaders(token) {
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export default function App() {
  const [tech, setTech] = useState('socketio')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin123')
  const [token, setToken] = useState(localStorage.getItem('bp_token') ?? '')
  const [author, setAuthor] = useState('juan')
  const [name, setName] = useState('plano-1')
  const [blueprints, setBlueprints] = useState([])
  const [points, setPoints] = useState([])
  const [persistedCount, setPersistedCount] = useState(0)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')

  const canvasRef = useRef(null)

  const socketRef = useRef(null)
  const socketListenerRef = useRef(null)
  const tabIdRef = useRef(`${Date.now()}-${Math.random()}`)

  const encodedAuthor = encodeURIComponent(author.trim())
  const encodedName = encodeURIComponent(name.trim())
  const room = `blueprints.${author.trim()}.${name.trim()}`

  const totalPoints = blueprints.reduce((acc, bp) => acc + getPointCount(bp), 0)

  useEffect(() => {
    fetchBlueprintsByAuthor()
  }, [author, token])

  useEffect(() => {
    fetchBlueprintByName()
  }, [author, name, token])

  useEffect(() => {
    drawAll(points)
  }, [points])

  function notifyTabs(type, payload = {}) {
    try {
      localStorage.setItem(
        'bp_sync_event',
        JSON.stringify({
          source: tabIdRef.current,
          type,
          ...payload,
          at: Date.now(),
        }),
      )
    } catch {
    }
  }

  useEffect(() => {
    function onStorage(event) {
      if (event.key !== 'bp_sync_event' || !event.newValue) return
      if (!token) return

      try {
        const data = JSON.parse(event.newValue)
        if (data?.source === tabIdRef.current) return
        if (data?.author !== author.trim()) return

        const currentName = name.trim()
        if (data?.type === 'delete' && data?.name === currentName) {
          setPoints([])
          setPersistedCount(0)
        }

        fetchBlueprintsByAuthor()

        if (data?.name === currentName && data?.type !== 'delete') {
          fetchBlueprintByName()
        }
      } catch {
      }
    }

    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [author, name, token])

  async function fetchBlueprintsByAuthor() {
    if (!token) {
      setBlueprints([])
      return
    }

    setError('')
    try {
      const response = await fetch(`${API_BASE}/api/blueprints/${encodedAuthor}`, {
        headers: authHeaders(token),
      })
      if (response.status === 404) {
        setBlueprints([])
        return
      }
      if (!response.ok) throw new Error(`No se pudo listar planos del autor (${response.status})`)
      const data = await response.json()
      setBlueprints(normalizeBlueprintList(unwrapData(data)))
    } catch (err) {
      setBlueprints([])
      setError(err instanceof Error ? err.message : 'Error al cargar la lista de planos')
    }
  }

  async function fetchBlueprintByName() {
    if (!token) {
      setPoints([])
      setPersistedCount(0)
      return
    }

    if (!author.trim() || !name.trim()) {
      setPoints([])
      setPersistedCount(0)
      return
    }

    setError('')
    try {
      const response = await fetch(`${API_BASE}/api/blueprints/${encodedAuthor}/${encodedName}`, {
        headers: authHeaders(token),
      })
      if (response.status === 404) {
        setPoints([])
        setPersistedCount(0)
        return
      }
      if (!response.ok) throw new Error(`No se pudo cargar el plano (${response.status})`)
      const data = await response.json()
      const blueprint = unwrapData(data)
      const loadedPoints = normalizePointsPayload(blueprint)
      setPoints(loadedPoints)
      setPersistedCount(loadedPoints.length)
    } catch (err) {
      setPoints([])
      setPersistedCount(0)
      setError(err instanceof Error ? err.message : 'Error al cargar el plano')
    }
  }

  function drawAll(allPoints) {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, 600, 400)
    if (!Array.isArray(allPoints) || allPoints.length === 0) return

    ctx.beginPath()
    allPoints.forEach((p, i) => {
      if (i === 0) {
        ctx.moveTo(p.x, p.y)
      } else {
        ctx.lineTo(p.x, p.y)
      }
    })
    ctx.stroke()
  }

  useEffect(() => {
    if (socketRef.current && socketListenerRef.current) {
      socketRef.current.off('blueprint-update', socketListenerRef.current)
    }
    socketRef.current?.disconnect?.()
    socketRef.current = null
    socketListenerRef.current = null

    if (!author.trim() || !name.trim()) {
      return
    }

    function handleRemoteUpdate(update) {
      if (Array.isArray(update?.points)) {
        if (update.points.length <= 1) {
          setPoints((prev) => [...prev, ...update.points])
        } else {
          setPoints(update.points)
        }
      } else if (update?.point) {
        setPoints((prev) => [...prev, update.point])
      }
    }

    const s = createSocket(IO_BASE)
    socketRef.current = s

    s.emit('join-room', room)
    socketListenerRef.current = (upd) => handleRemoteUpdate(upd)
    s.on('blueprint-update', socketListenerRef.current)
    s.on('connect_error', () => setError('No fue posible conectar con Socket.IO'))

    return () => {
      if (socketRef.current && socketListenerRef.current) {
        socketRef.current.off('blueprint-update', socketListenerRef.current)
      }
      socketRef.current?.disconnect?.()
    }
  }, [tech, author, name])

  async function refreshAfterMutation() {
    await fetchBlueprintsByAuthor()
    await fetchBlueprintByName()
  }

  async function login() {
    if (!username.trim() || !password.trim()) {
      setError('Debes ingresar usuario y contraseña')
      return
    }

    setIsBusy(true)
    setError('')
    try {
      let response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })

      if (response.status === 404) {
        response = await fetch(`${API_BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.trim(), password }),
        })
      }

      if (!response.ok) throw new Error('Login fallido. Verifica credenciales')

      const data = await response.json()
      if (!data?.access_token) throw new Error('Respuesta de login inválida: no llegó access_token')

      setToken(data.access_token)
      localStorage.setItem('bp_token', data.access_token)
    } catch (err) {
      setToken('')
      localStorage.removeItem('bp_token')
      setError(err instanceof Error ? err.message : 'Error de autenticación')
    } finally {
      setIsBusy(false)
    }
  }

  function logout() {
    setToken('')
    localStorage.removeItem('bp_token')
    setBlueprints([])
    setPoints([])
    setPersistedCount(0)
    setError('')
  }

  async function createBlueprint() {
    if (!token) {
      setError('Haz login antes de crear')
      return
    }

    if (!author.trim() || !name.trim()) {
      setError('Debes definir autor y nombre del plano para crear')
      return
    }

    setIsBusy(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE}/api/blueprints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ author: author.trim(), name: name.trim(), points }),
      })
      if (!response.ok) throw new Error(`No se pudo crear el plano (${response.status}). Usa usuario admin para permisos de escritura`) 
      setPersistedCount(points.length)
      await refreshAfterMutation()
      notifyTabs('create', { author: author.trim(), name: name.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear el plano')
    } finally {
      setIsBusy(false)
    }
  }

  async function saveBlueprint() {
    if (!token) {
      setError('Haz login antes de guardar')
      return
    }

    if (!author.trim() || !name.trim()) {
      setError('Debes definir autor y nombre del plano para guardar')
      return
    }

    const pendingPoints = points.slice(persistedCount)
    if (pendingPoints.length === 0) {
      setError('No hay puntos nuevos para guardar')
      return
    }

    setIsBusy(true)
    setError('')
    try {
      for (const point of pendingPoints) {
        const response = await fetch(`${API_BASE}/api/blueprints/${encodedAuthor}/${encodedName}/points`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
          body: JSON.stringify(point),
        })
        if (!response.ok) throw new Error(`No se pudo actualizar el plano (${response.status})`)
      }
      setPersistedCount(points.length)
      await refreshAfterMutation()
      notifyTabs('save', { author: author.trim(), name: name.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar el plano')
    } finally {
      setIsBusy(false)
    }
  }

  async function deleteBlueprint() {
    if (!token) {
      setError('Haz login antes de eliminar')
      return
    }

    if (!author.trim() || !name.trim()) {
      setError('Debes definir autor y nombre del plano para eliminar')
      return
    }

    setIsBusy(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE}/api/blueprints/${encodedAuthor}/${encodedName}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      })
      if (!response.ok) throw new Error(`No se pudo eliminar el plano (${response.status})`)
      setPoints([])
      setPersistedCount(0)
      await fetchBlueprintsByAuthor()
      notifyTabs('delete', { author: author.trim(), name: name.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar el plano')
    } finally {
      setIsBusy(false)
    }
  }

  function onCanvasClick(e) {
    if (!token) {
      setError('Haz login antes de dibujar')
      return
    }

    if (!author.trim() || !name.trim()) {
      setError('Debes definir autor y nombre antes de dibujar')
      return
    }

    const rect = e.target.getBoundingClientRect()
    const point = { x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) }
    setPoints((prev) => [...prev, point])

    setError('')

    if (socketRef.current?.connected) {
      socketRef.current.emit('draw-event', { room, author: author.trim(), name: name.trim(), point })
    }
  }

  return (
    <div style={{ fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif', padding: 16, maxWidth: 980, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 10 }}>BluePrints en Tiempo Real</h2>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #eee' }}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="usuario" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="contraseña" type="password" />
        <button type="button" onClick={login} disabled={isBusy}>Login</button>
        <button type="button" onClick={logout} disabled={isBusy || !token}>Logout</button>
        <span style={{ opacity: 0.8 }}>{token ? 'Sesión activa' : 'Sin autenticación'}</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label htmlFor="tech">Tecnología RT:</label>
        <select id="tech" value={tech} onChange={(e) => setTech(e.target.value)}>
          <option value="socketio">Socket.IO (Node)</option>
        </select>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="autor" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="plano" />
        <button type="button" onClick={createBlueprint} disabled={isBusy}>Create</button>
        <button type="button" onClick={saveBlueprint} disabled={isBusy}>Save/Update</button>
        <button type="button" onClick={deleteBlueprint} disabled={isBusy}>Delete</button>
      </div>

      {error && <p style={{ color: '#b42318', marginTop: 0 }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 12, alignItems: 'start' }}>
        <section style={{ border: '1px solid #ddd', borderRadius: 10, padding: 10 }}>
          <h3 style={{ marginTop: 0 }}>Planos de {author || '(autor vacío)'}</h3>
          <p style={{ marginTop: 0, marginBottom: 8, opacity: 0.8 }}>Total de puntos: {totalPoints}</p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #e8e8e8', paddingBottom: 6 }}>Nombre</th>
                <th style={{ textAlign: 'right', borderBottom: '1px solid #e8e8e8', paddingBottom: 6 }}>Puntos</th>
              </tr>
            </thead>
            <tbody>
              {blueprints.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ paddingTop: 8, opacity: 0.7 }}>Sin datos para este autor</td>
                </tr>
              )}
              {blueprints.map((bp) => (
                <tr
                  key={`${bp.author ?? author}-${bp.name}`}
                  onClick={() => {
                    setName(bp.name)
                    setError('')
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ padding: '6px 0' }}>{bp.name}</td>
                  <td style={{ textAlign: 'right' }}>{getPointCount(bp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <canvas
            ref={canvasRef}
            width={600}
            height={400}
            style={{ border: '1px solid #ddd', borderRadius: 12, width: '100%', maxWidth: 600, background: '#fff' }}
            onClick={onCanvasClick}
          />
          <p style={{ opacity: 0.75, marginTop: 8 }}>
            Plano activo: <strong>{author || '(sin autor)'}</strong> / <strong>{name || '(sin nombre)'}</strong> | Puntos: {points.length}
          </p>
        </section>
      </div>
    </div>
  )
}

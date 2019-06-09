import {
  BackendState,
  GameDimensions,
  PlayerDirections,
  PlayerRegistry,
  SERVER_UPDATE_INTERVAL,
  SimpleCoordinates,
  SocketEvents,
  TPowerUpInfo,
  TPowerUpType
} from 'commons'
import * as SocketIO from 'socket.io'
import { Socket } from 'socket.io'

type TRandomSlot = SimpleCoordinates & { slot: keyof BackendState['slots'] }

function randomOfList<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function findRandomSlot(state: BackendState): TRandomSlot | undefined {
  const centerXOffset = (GameDimensions.tileWidth / 2) - (GameDimensions.playerHeight / 2)
  const centerYOffset = (GameDimensions.tileHeight / 2) - (GameDimensions.playerWidth / 2)
  const availableSlots: TRandomSlot[] = []

  if (!state.slots.first) {
    availableSlots.push({
      slot: 'first',
      x: centerXOffset,
      y: centerYOffset
    })
  }

  if (!state.slots.second) {
    availableSlots.push({
      slot: 'second',
      x: GameDimensions.gameWidth - centerXOffset,
      y: centerYOffset
    })
  }

  if (!state.slots.third) {
    availableSlots.push({
      slot: 'third',
      x: centerXOffset,
      y: GameDimensions.gameHeight - centerYOffset
    })
  }

  if (!state.slots.fourth) {
    availableSlots.push({
      slot: 'fourth',
      x: GameDimensions.gameWidth - centerXOffset,
      y: GameDimensions.gameHeight - centerYOffset
    })
  }

  if (availableSlots.length >= 1) {
    return randomOfList(availableSlots)
  }
}


export function initGameSocketListeners(io: SocketIO.Server) {
  const state: BackendState = {
    remainingTime: 300,
    slots: {},
    playerRegistry: {},
    destroyedWalls: []
  }

  const updateInterval = setInterval(function () {
    io.sockets.emit(SocketEvents.StateUpdate, state)
  }, SERVER_UPDATE_INTERVAL)

  const timoutInterval = setInterval(function () {
    state.remainingTime--

    if (state.remainingTime < 1) {
      updateInterval && clearInterval(updateInterval)
      timoutInterval && clearInterval(timoutInterval)
    }
  }, 1000)

  return function (playerId: string, socket: Socket) {
    socket.on('ReadyForEvents', () => {
      const position = findRandomSlot(state)
      if (position) {
        const newPlayer: PlayerRegistry = {
          isDead: false,
          slot: position.slot,
          status: {
            bombRange: 2,
            maxBombCount: 1
          },
          directions: {
            down: false,
            left: false,
            right: false,
            up: false,
            ...position
          }
        }

        console.log(`New player ${ playerId } joins at x ${ newPlayer.directions.x } y ${ newPlayer.directions.x } on slot ${ [position.slot] }`)
        state.slots[newPlayer.slot] = position
        state.playerRegistry[playerId] = newPlayer

        socket.emit(SocketEvents.InitWithState, { ...state, id: playerId })
        socket.broadcast.emit(SocketEvents.NewPlayer, { ...newPlayer, id: playerId })
      } else {
        socket.emit(SocketEvents.InitWithState, { ...state, id: playerId })
      }
    })

    socket.on(SocketEvents.Movement, (directions: PlayerDirections) => {
      const player = state.playerRegistry[playerId]
      if (player && !player.isDead) {
        player.directions = directions
      }
    })

    socket.on(SocketEvents.Disconnect, () => {
      const player = state.playerRegistry[playerId]
      if (player) {
        delete state.slots[player.slot]
        delete state.playerRegistry[playerId]
      }

      io.sockets.emit(SocketEvents.PlayerDisconnect, playerId)
    })

    socket.on(SocketEvents.NewBombAt, (coords: SimpleCoordinates & { ownerId: string }) => {
      const player = state.playerRegistry[playerId]

      if (player && !player.isDead) {
        socket.broadcast.emit(SocketEvents.NewBombAt, {
          ...coords,
          range: player.status.bombRange
        })
      }
    })

    socket.on(SocketEvents.WallDestroyed, (coordinates: SimpleCoordinates) => {
      state.destroyedWalls = state.destroyedWalls.concat(coordinates)

      const rand = Math.random() * 100
      if (rand <= 10 || rand >= 90) {
        const randomPower = randomOfList(
          ['BombRange', 'BombCount'] as TPowerUpType[]
        )

        const newPowerAt: TPowerUpInfo = {
          ...coordinates,
          powerUpType: randomPower
        }

        io.sockets.emit(SocketEvents.NewPowerUpAt, newPowerAt)
      }
    })

    socket.on(SocketEvents.PlayerDied, (deadPlayerId: string) => {
      console.log('Player ', deadPlayerId, ' died')

      if (deadPlayerId in state.playerRegistry) {
        state.playerRegistry[deadPlayerId].isDead = true
      }

      socket.broadcast.emit(SocketEvents.PlayerDied, deadPlayerId)
    })

    socket.on(SocketEvents.PowerUpCollected, (info: { id: string, type: TPowerUpType }) => {
      const player = state.playerRegistry[playerId]

      if (player) {
        switch (info.type) {
          case 'BombRange':
            player.status.bombRange++
            break
          case 'BombCount':
            player.status.maxBombCount++
            break
        }

        socket.emit(SocketEvents.PlayerStatusUpdate, {
          id: info.id,
          ...player.status
        })
      }
    })
  }
}
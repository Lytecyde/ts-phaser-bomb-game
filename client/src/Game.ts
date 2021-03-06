import {
  BackendState,
  GameDimensions,
  PlayerDirections,
  PlayerRegistry,
  PlayerStatus,
  SimpleCoordinates,
  SocketEvents,
  TPowerUpInfo,
  TPowerUpType
} from "commons";
import Phaser from "phaser";
import { Update } from "./Update"; 
import { ANIMATIONS, ASSETS, BOMB_TIME, MAIN_TILES, MAPS } from "./assets";
import {
  GamePhysicsSprite,
  GameScene,
  GameSprite,
  TPlayerGameObject,
  TPowerUpGameObject
} from "./alias";
import { GroupManager } from "./GroupManager";
import Socket = SocketIOClient.Socket;

const debug = false;

type ExplosionCache = Array<{ sprite: GameSprite; key: string }>;

type BombMap = {
  [xy: string]: {
    sprite: GameSprite;
    range: number;
  };
};

interface Directions {
  left: boolean;
  right: boolean;
  down: boolean;
  up: boolean;
}

interface BombGameConfigs {
  parent: HTMLElement | string;
  onDeath: () => unknown;
  onStart: () => unknown;

  onStatusUpdate(status: PlayerStatus): void;
}

interface SceneMap {
  map: Phaser.Tilemaps.Tilemap;
  tiles: Phaser.Tilemaps.Tileset;
  layer: Phaser.Tilemaps.DynamicTilemapLayer;
}

type TNewBombInfo = SimpleCoordinates & { range: number };

function inRange(r: { min: number; max: number; value: number }) {
  return r.value >= r.min && r.value <= r.max;
}

function gridUnitToPixel(value: number, baseGridSize: number) {
  return value * baseGridSize + baseGridSize / 2;
}

function makeKey({ x, y }: SimpleCoordinates) {
  return `${x}-${y}`;
}

function findPlayerMapPosition(coords: SimpleCoordinates): SimpleCoordinates {
  const { tileWidth, tileHeight } = GameDimensions;
  return {
    x: Math.floor(coords.x / tileWidth),
    // +(tileHeight / 2) is a precision fix :D
    y: Math.floor((coords.y + tileHeight / 2) / tileHeight)
  };
}

export function BombGame(socket: Socket, gameConfigs: BombGameConfigs) {
  let spawnedBombCount = 0;
  let playerId: string;
  let phaserInstance: Phaser.Game;
  let backgroundMap: SceneMap;
  let breakableMap: SceneMap;
  let currentScene: GameScene;
  let wallsMap: SceneMap;
  const bombMap: BombMap = {};
  let groups: GroupManager;
  const explosionMap: { [xy: string]: GameSprite } = {};
  const playerRegistry: {
    [id: string]: PlayerRegistry & {
      player: Phaser.Physics.Arcade.Sprite;
    };
  } = {};

  const makeDefaultTileMap = (key: string, imageName: string): SceneMap => {
    const map = currentScene.make.tilemap({
      key,
      tileWidth: GameDimensions.tileWidth,
      tileHeight: GameDimensions.tileHeight
    });

    const tiles = map.addTilesetImage(imageName);
    const layer = map.createDynamicLayer(0, tiles, 0, 0);

    return { layer, map, tiles };
  };
  
  //PRELOAD

  const preload = () => {
    const scene = currentScene;
    scene.load.image(MAIN_TILES, "assets/tileset.png");
    scene.load.tilemapCSV(MAPS.BACKGROUND, "assets/map_background.csv");
    scene.load.tilemapCSV(MAPS.WALLS, "assets/map_walls.csv");
    scene.load.tilemapCSV(MAPS.BREAKABLES, "assets/map_breakables.csv");
    scene.load.image(ASSETS.DED, "assets/ded.png");
    scene.load.spritesheet(ASSETS.PLAYER, "assets/dude.png", {
      frameWidth: GameDimensions.playerWidth,
      frameHeight: GameDimensions.playerHeight
    });

  
    const gameAssets = new Map([
      [ASSETS.BOMB, "assets/bomb.png"],
      [ASSETS.EXPLOSION, "assets/explosion.png"],
      [ASSETS.DED, "assets/ded.png"],
      [ASSETS.BOMB_COUNT_POWERUP, "assets/bomb_count_powerup.png"],
      [ASSETS.BOMB_RANGE_POWERUP, "assets/bomb_range_powerup.png"]
    ]
    );
    
    for(let [assetName, assetPath] of gameAssets) {
      var frameDimensions = {
        frameWidth: GameDimensions.tileWidth,
        frameHeight: GameDimensions.tileHeight
      };
      scene.load.spritesheet(
        assetName, 
        assetPath, 
        frameDimensions  
      );
    };
  };

  const applyPhysicsAndAnimations = (
    sprite: GamePhysicsSprite,
    { left, right, down, up }: Directions
  ) => {
    const velocity = 160;
    //TODO: remove all elses
    if (left) {
      sprite.setVelocityX(-velocity);
      sprite.anims.play(ANIMATIONS.PLAYER_TURN_LEFT, true);
    } 
    
    if (right) {
      sprite.setVelocityX(velocity);
      sprite.anims.play(ANIMATIONS.PLAYER_TURN_RIGHT, true);
    } 
    
    if (!left || !right){
      sprite.setVelocityX(0);
    }

    if (down) {
      sprite.setVelocityY(-velocity);
      sprite.anims.play(ANIMATIONS.PLAYER_TURN_DOWN, true);
    } 
    
    if (up) {
      sprite.setVelocityY(velocity);
      sprite.anims.play(ANIMATIONS.PLAYER_TURN_UP, true);
    } 
    
    if (!up || !down){
      sprite.setVelocityY(0);
    }

    if (!down && !up && !left && !right) {
      sprite.anims.play(ANIMATIONS.PLAYER_TURN_UP);
    }
  };

  const makeMaps = () => {
    // Background
    backgroundMap = makeDefaultTileMap(MAPS.BACKGROUND, MAIN_TILES);

    // Walls
    wallsMap = makeDefaultTileMap(MAPS.WALLS, MAIN_TILES);
    wallsMap.map.setCollisionBetween(0, 2);

    // Breakables
    breakableMap = makeDefaultTileMap(MAPS.BREAKABLES, MAIN_TILES);
    breakableMap.map.setCollisionBetween(0, 2);
  };

  //INIT

  const initPhaser = (state: BackendState & { id: string }) => {
    phaserInstance = new Phaser.Game({
      type: Phaser.AUTO,
      parent: gameConfigs.parent,
      width: GameDimensions.gameWidth,
      height: GameDimensions.gameHeight,
      physics: {
        default: "arcade",
        arcade: {
          gravity: {},
          debug
        }
      },
      scene: {
        preload: function(this: GameScene) {
          currentScene = this;
          preload();
        },
        create: function(this: GameScene) {
          currentScene = this;
          create(state);
          gameConfigs.onStart();
        },
        update: function(this: GameScene) {
          currentScene = this;
          update();
        }
      }
    });
  };

  //TODO: rename fabric
  const fabricPlayer = (
      id: string,
      directions: PlayerDirections
    ): Phaser.Physics.Arcade.Sprite => {
    var playerAssetName = ASSETS.PLAYER;

    const player = currentScene.physics.add.sprite(
      directions.x,
      directions.y,
      playerAssetName,
      1
    );

    player.setBounce(1.2);
    player.setCollideWorldBounds(true);

    groups.addPlayer(player, id);

    // TODO: put this in the group
    currentScene.physics.add.collider(player, breakableMap.layer);
    currentScene.physics.add.collider(player, wallsMap.layer);

    // Make the collision height smaller
    const radius = GameDimensions.playerBoxRadius;
    player.body.setCircle(
      radius,
      (GameDimensions.playerWidth - radius * 2) / 2,
      GameDimensions.playerHeight - radius * 2
    );

    return player;
  };


  //TODO: create 3 functions because initWithState does many things
  const initWithState = (state: BackendState & { id: string }) => {
    playerId = socket.id; // state.id;
    groups = new GroupManager(() => currentScene);

    function addFabricPlayers(id: string) {
      for (const [id, data] of Object.entries(state.playerRegistry)) {
        playerRegistry[id] = {
          ...data,
          player: fabricPlayer(id, data.directions)
        };
      }
    }
    
    addFabricPlayers(playerId);


    function removeDestroyedWalls(state: BackendState) {
      for (const { x, y } of state.destroyedWalls) {
        breakableMap.map.removeTileAt(x, y);
      }
    }

    removeDestroyedWalls(state);

    groups
      .registerBombCollider()
      .onPlayerPowerUpCatch(processPowerUpCatch)
      .onPlayerExploded(processPlayerDeath);
  };

  const processPowerUpCatch = (
    player: TPlayerGameObject,
    powerUp: TPowerUpGameObject
  ) => {
    const id = player.id!;
    const registry = playerRegistry[player.id!];

    if (registry) {
      if (playerId === id) {
        socket.emit(SocketEvents.PowerUpCollected, {
          id,
          type: powerUp.powerUpType!
        });
      }
    } else {
      debug && console.debug("Registry not found ", id);
    }

    // Remove the power up sprite
    powerUp.destroy(true);
  };

  const processPlayerDeath = (id: string) => {
    const registry = playerRegistry[id];
    // To not overload the server, only the player itself can say
    // that he/she was killed
    if (registry) {
      if (!registry.isDead && playerId === id) {
        registry.isDead = true;
        socket.emit(SocketEvents.PlayerDied, id);
        gameConfigs.onDeath();
      }
    } else {
      debug && console.debug("Registry not found ", id);
    }
  };

  //SOCKET CODE

  const initSocketListeners = () => {
    socket.on(
      SocketEvents.NewPlayer,
      (registry: PlayerRegistry & { id: string }) => {
        playerRegistry[registry.id] = {
          ...registry,
          player: fabricPlayer(registry.id, registry.directions)
        };
      }
    );

    socket.on(SocketEvents.PlayerDisconnect, (playerId: string) => {
      const registry = playerRegistry[playerId];
      if (registry) {
        registry.player.destroy(true);
        delete playerRegistry[playerId];
      }
    });

    socket.on(SocketEvents.PlayerDied, (playerId: string) => {
      const registry = playerRegistry[playerId];
      var deadSpot = [ -1,  -1];
      if (registry) {
        registry.player.destroy(true);
        delete playerRegistry[playerId];
        // display ded.png 
        deadSpot = [registry.directions.x, registry.directions.y];
        var playerAssetName = ASSETS.DED;

        const player = currentScene.physics.add.sprite(
          deadSpot[0], //x
          deadSpot[1], //y
          playerAssetName,
          1
        );
        groups.addPlayer(player, playerId);
      }
    });

    socket.on(SocketEvents.StateUpdate, (backState: BackendState) => {
      for (const [id, data] of Object.entries(backState.playerRegistry)) {
        if (playerId !== id) {
          playerRegistry[id].directions = data.directions;
        }
      }
    });

    socket.on(
      SocketEvents.PlayerStatusUpdate,
      (status: PlayerStatus & { id: string }) => {
        const registry = playerRegistry[status.id];

        if (registry) {
          registry.status = status;

          if (status.id === playerId) {
            gameConfigs.onStatusUpdate(status);
          }
        }
      }
    );

    socket.on(SocketEvents.NewBombAt, (info: TNewBombInfo) => {
      setupBombAt(info);
    });

    socket.on(SocketEvents.NewPowerUpAt, (info: TPowerUpInfo) => {
      placePowerUpAt(info);
    });

    socket.on(SocketEvents.WallDestroyed, ({ x, y }: SimpleCoordinates) => {
      breakableMap.map.removeTileAt(x, y);
    });
  };

  // CREATE
  //create  a map of objects with start and end numbers for each move
  const create = (state: BackendState & { id: string }) => {
    makeMaps();
    initWithState(state);
    initSocketListeners();
    const scene = currentScene;

    const bombAssets = new Map(
      [
        [ASSETS.BOMB, ANIMATIONS.BOMB_PULSE],
        [ASSETS.BOMB_COUNT_POWERUP, ANIMATIONS.BOMB_COUNT],
        [ASSETS.BOMB_RANGE_POWERUP, ANIMATIONS.BOMB_RANGE]
      ]
    );

    for(let [assetName, animationKey] of bombAssets){
      scene.anims.create({
        key: animationKey,
        frames: scene.anims.generateFrameNumbers(assetName, {
          start: 0,
          end: 1
        }),
        frameRate: 2,
        repeat: -1
      });
    };

    // Player animations
    //TODO: should be function
    scene.anims.create({
      key: ANIMATIONS.PLAYER_TURN_LEFT,
      frames: scene.anims.generateFrameNumbers(
        ASSETS.PLAYER, 
        {
          start: 0,
          end: 3
        }
      ),
      frameRate: 10,
      repeat: -1
    });

    scene.anims.create({
      key: ANIMATIONS.PLAYER_TURN_RIGHT,
      frames: scene.anims.generateFrameNumbers(ASSETS.PLAYER, {
        start: 4,
        end: 7
      }),
      frameRate: 10,
      repeat: -1
    });

    scene.anims.create({
      key: ANIMATIONS.PLAYER_TURN_UP,
      frames: scene.anims.generateFrameNumbers(ASSETS.PLAYER, {
        start: 10,
        end: 11
      }),
      frameRate: 5,
      repeat: -1
    });

    scene.anims.create({
      key: ANIMATIONS.PLAYER_TURN_DOWN,
      frames: scene.anims.generateFrameNumbers(ASSETS.PLAYER, {
        start: 8,
        end: 9
      }),
      frameRate: 5,
      repeat: -1
    });
  };

  const hasAnyWallAt = (gridX: number, gridY: number) => {
    return (
      wallsMap.map.hasTileAt(gridX, gridY) ||
      breakableMap.map.hasTileAt(gridX, gridY)
    );
  };

  const hasBreakableWallAt = (gridX: number, gridY: number) => {
    return breakableMap.map.hasTileAt(gridX, gridY);
  };

  const addExplosionSprite = ({
    pixX,
    pixY,
    gridX,
    gridY
  }: {
    pixX: number;
    pixY: number;
    gridX: number;
    gridY: number;
  }): { key: string; sprite: GameSprite } => {
    const sprite = currentScene.add.sprite(pixX, pixY, ASSETS.EXPLOSION);
    const killer = currentScene.physics.add.existing(sprite, true);
    const physicsBody = (killer.body as unknown) as Phaser.Physics.Arcade.Body;
    physicsBody.setCircle(GameDimensions.tileHeight / 2);

    groups.addExplosion(killer);
    const key = makeKey({ x: gridX, y: gridY });

    return { key, sprite };
  };


  //TODO: deal with the if structure
  const putAndExplodeAdjacent = (
    cache: ExplosionCache,
    gridX: number,
    gridY: number
  ) => {
    const { tileWidth, tileHeight } = GameDimensions;

    if (hasBombAt({ x: gridX, y: gridY })) {
      console.log(`Found a bomb at ${gridX} - ${gridY}, delegated to it`);
      // Let the next bomb deal with things
      explodeBombAt(gridX, gridY);
      return true;
    } else if (hasExplosionAt({ x: gridX, y: gridY })) {
      console.log(`Found an explosion at ${gridX} - ${gridY}, stopping`);
      return true;
    } else if (hasAnyWallAt(gridX, gridY)) {
      // No Explosions at walls

      if (hasBreakableWallAt(gridX, gridY)) {
        // Breakable is replaced by a explosion
        const pixX = gridUnitToPixel(gridX, tileWidth);
        const pixY = gridUnitToPixel(gridY, tileHeight);

        const { key, sprite } = addExplosionSprite({
          pixX,
          pixY,
          gridX,
          gridY
        });
        cache.push({ sprite, key });
        explosionMap[key] = sprite;

        destroyWallAt(gridX, gridY);
      }

      return true;
    } else {
      const pixX = gridUnitToPixel(gridX, tileWidth);
      const pixY = gridUnitToPixel(gridY, tileHeight);

      const { key, sprite } = addExplosionSprite({
        pixX,
        pixY,
        gridX,
        gridY
      });

      cache.push({ sprite, key });
      explosionMap[key] = sprite;

      return false;
    }
  };

  const putExplosionAt = (x: number, y: number, range: number) => {
    const explosions: ExplosionCache = [];

    // The bomb itself
    putAndExplodeAdjacent(explosions, x, y);

    for (let i = x + 1; i <= x + range; i++) {
      const foundObstacle = putAndExplodeAdjacent(explosions, i, y);
      if (foundObstacle) {
        break;
      }
    }

    for (let i = x - 1; i >= x - range; i--) {
      const foundObstacle = putAndExplodeAdjacent(explosions, i, y);
      if (foundObstacle) {
        break;
      }
    }

    for (let i = y + 1; i <= y + range; i++) {
      const foundObstacle = putAndExplodeAdjacent(explosions, x, i);
      if (foundObstacle) {
        break;
      }
    }

    for (let i = y - 1; i >= y - range; i--) {
      const foundObstacle = putAndExplodeAdjacent(explosions, x, i);
      if (foundObstacle) {
        break;
      }
    }

    setTimeout(() => {
      explosions.forEach(({ sprite, key }) => {
        sprite.destroy(true);
        delete explosionMap[key];
      });
    }, 400);
  };

  const destroyWallAt = (x: number, y: number) => {
    breakableMap.map.removeTileAt(x, y);
    socket.emit(SocketEvents.WallDestroyed, { x, y });
  };

  const getCurrentPlayer = () => {
    return playerRegistry[playerId];
  };

  //TODO: DONE, refactor : remove else
  const setupPlayerBombAt = (x: number, y: number) => {
    const player = getCurrentPlayer();
    const hasSufficientBombs = spawnedBombCount >= player.status.maxBombCount;
    if (!(hasSufficientBombs || player.isDead)) {
      spawnedBombCount++;
      registerBombAt(x, y, player.status.bombRange);
      socket.emit(SocketEvents.NewBombAt, { x, y, ownerId: playerId });

      setTimeout(() => {
        explodeBombAt(x, y);
        spawnedBombCount--;
      }, BOMB_TIME);
    } 
  };

  const setupBombAt = ({ x, y, range }: TNewBombInfo) => {
    registerBombAt(x, y, range);
    setTimeout(() => {
      explodeBombAt(x, y);
    }, BOMB_TIME);
  };

  const registerBombAt = (x: number, y: number, range: number) => {
    const { tileWidth, tileHeight } = GameDimensions;
    const nX = gridUnitToPixel(x, tileWidth);
    const nY = gridUnitToPixel(y, tileHeight);
    const newBomb = currentScene.add.sprite(nX, nY, ASSETS.BOMB, 1);
    const key = makeKey({ x, y });

    bombMap[key] = { sprite: newBomb, range };

    const bombCollide = currentScene.physics.add.existing(newBomb, true);
    groups.addBomb(bombCollide);
  };

  const explodeBombAt = (gridX: number, gridY: number) => {
    const key = makeKey({ x: gridX, y: gridY });
    const player = getCurrentPlayer();

    if (hasBombAt({ x: gridX, y: gridY })) {
      const bomb = bombMap[key];
      bomb.sprite.destroy(true);
      player;
      delete bombMap[key];

      putExplosionAt(gridX, gridY, bomb.range);
    }
  };

  const hasBombAt = (coords: SimpleCoordinates): boolean => {
    return makeKey(coords) in bombMap;
  };

  const hasExplosionAt = (coords: SimpleCoordinates): boolean => {
    return makeKey(coords) in explosionMap;
  };

  // UPDATE :: 

  const update = () => {
    Update(groups, playerRegistry, playerId, currentScene);
  };

  const getPowerAsset = (type: TPowerUpType) => {
    switch (type) {
      case "BombCount":
        return ASSETS.BOMB_COUNT_POWERUP;
      case "BombRange":
        return ASSETS.BOMB_COUNT_POWERUP;
    }
  };

  const placePowerUpAt = (info: TPowerUpInfo) => {
    const { tileWidth, tileHeight } = GameDimensions;
    const pixX = gridUnitToPixel(info.x, tileWidth);
    const pixY = gridUnitToPixel(info.y, tileHeight);

    const powerUp = currentScene.add.sprite(
      pixX,
      pixY,
      getPowerAsset(info.powerUpType),
      1
    );

    const collider = currentScene.physics.add.existing(powerUp, true);
    groups.addPowerUp(collider, info.powerUpType);
  };

  const startGame = () => {
    socket.on(
      SocketEvents.InitWithState,
      (state: BackendState & { id: string }) => {
        // Happens at server restarts
        if (!phaserInstance) {
          initPhaser(state);
        }
      }
    );
  };

  return { startGame };
}

import { PlayerRegistry } from "commons";
import { GameScene } from "./alias";
import { GroupManager } from "./GroupManager";
import Socket = SocketIOClient.Socket;

const playerRegistry: {
  [id: string]: PlayerRegistry & {
    player: Phaser.Physics.Arcade.Sprite;
  };
} = {};

export function Update ( groups:GroupManager, playerRegistry: PlayerRegistry , playerId: string, currentScene:GameScene ){ //ERROR in parameters
    //const scene = currentScene;

    groups.playAnimations();

    const scene = currentScene;

    for (const [id, registry] of Object.entries(playerRegistry)) {
      const { player, directions } = registry;

      if (playerId === id) {
        const cursors = scene.input.keyboard.createCursorKeys();

        if (playerRegistry[id].isDead) {
          Object.assign(directions, {
            left: false,
            right: false,
            down: false,
            up: false,
            x: player.x,
            y: player.y
          });
        } else {
          Object.assign(directions, {
            left: cursors.left!.isDown,
            right: cursors.right!.isDown,
            down: cursors.up!.isDown,
            up: cursors.down!.isDown,
            x: player.x,
            y: player.y
          });
        }

        // BombGame.applyPhysicsAndAnimations(player, directions);

        if (cursors.space!.isDown) {
          const { x, y } = findPlayerMapPosition(player);
          if (!hasBombAt({ x, y })) {
            setupPlayerBombAt(x, y);
          }
        }
      }
      // Fixes some position imprecision (from player animations)
      const tolerance = 10;
      const isXOk = inRange({
        min: directions.x - tolerance,
        max: directions.x + tolerance,
        value: player.x
      });
      const isYOk = inRange({
        min: directions.y - tolerance,
        max: directions.y + tolerance,
        value: player.y
      });

      if (!isXOk || !isYOk) {
        player.x = directions.x;
        player.y = directions.y;
      } else {
        applyPhysicsAndAnimations(player, directions);
      }
    }

    // Update server
    const player = playerRegistry[playerId];
    if (player) {
      socket.emit(SocketEvents.Movement, player.directions);
    }
}
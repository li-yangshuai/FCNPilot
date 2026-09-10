#pragma once

// Derived from iFCN genetic/individual placement search, commit
// 2f5e4899e820f30581d9fd9fcf2eabd8d4f0e2bc. Headless candidates use hard
// feasibility checks before any area/cell objective is compared.
#include "astar.h"
#include "autopr/graph/parse.h"
#include <chrono>
#include <limits>
#include <map>
#include <string>

namespace fcngraph {
using RegularPlacements = std::map<unsigned int, position>;
using RegularRoutes = std::map<std::pair<unsigned int, unsigned int>, std::vector<position>>;

struct RegularEvaluation {
    bool valid = false;
    std::size_t routed_edges = 0;
    std::size_t mapped_cells = 0;
    std::size_t physical_area = 0;
    std::size_t tile_area = 0;
    std::size_t routed_tiles = 0;
    std::map<unsigned int, unsigned int> arrival_ticks;
    std::string error;
};

RegularEvaluation validateRegularCandidate(Parse& parse, GridChessboard& board,
                                           const RegularPlacements& nodes,
                                           const RegularRoutes& routes);

class Individual {
public:
    RegularPlacements nodeindex_pos;
    RegularRoutes routes;
    RegularEvaluation evaluation;
    void computeFitness(Parse& parse, GridChessboard& board, Astar& router,
                        std::chrono::steady_clock::time_point deadline);
    bool betterThan(const Individual& other) const;
};
}
